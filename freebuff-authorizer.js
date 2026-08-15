import { randomBytes, randomUUID } from 'node:crypto';
import { fetch as undiciFetch } from 'undici';

const DEFAULT_BASE_URL = 'https://www.codebuff.com';
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 1000;
const RESULT_RETENTION_MS = 60 * 1000;
const MAX_PENDING_AUTHORIZATIONS = 32;
const MAX_JSON_BYTES = 256 * 1024;
const BROWSER_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

export class FreebuffAuthorizationError extends Error {
  constructor(message, status = 400, code = 'FREEBUFF_AUTH_INVALID') {
    super(message);
    this.name = 'FreebuffAuthorizationError';
    this.status = status;
    this.code = code;
  }
}

function boundedText(value, field, max, { required = false } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && !text) {
    throw new FreebuffAuthorizationError(`Freebuff authorization response is missing ${field}`, 502, 'FREEBUFF_AUTH_RESPONSE_INVALID');
  }
  if (text.length > max || /[\r\n\0]/.test(text)) {
    throw new FreebuffAuthorizationError(`Freebuff authorization response has invalid ${field}`, 502, 'FREEBUFF_AUTH_RESPONSE_INVALID');
  }
  return text;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function displayEmail(user) {
  const value = typeof user?.email === 'string' ? user.email.trim() : '';
  return value && value.length <= 254 && !/[\r\n\0]/.test(value) ? value : '';
}

function displayName(user, authorizationId) {
  const email = displayEmail(user);
  if (email) return email.slice(0, 80);
  const upstreamId = typeof user?.id === 'string' ? user.id.trim().replace(/[\r\n\0]/g, '') : '';
  if (upstreamId) return `Freebuff ${upstreamId.slice(0, 64)}`;
  return `Freebuff ${authorizationId.slice(0, 8)}`;
}

function publicAccount(account) {
  if (!account || typeof account !== 'object') return null;
  return {
    id: account.id || null,
    name: account.name || '',
    email: account.email || '',
    enabled: account.enabled === true,
    proxyRequired: account.proxyRequired === true,
    hasProxy: account.hasProxy === true,
    proxyUrlMasked: account.proxyUrlMasked || null,
    proxyProtocol: account.proxyProtocol || null,
    createdAt: account.createdAt || null,
    updatedAt: account.updatedAt || null,
  };
}

function safeNow(now) {
  const value = Number(now());
  if (!Number.isFinite(value)) throw new Error('authorization clock returned an invalid value');
  return value;
}

function safeDuration(value, fallback, name) {
  const parsed = Number(value === undefined ? fallback : value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}

export class FreebuffAuthorizer {
  constructor({
    accountService,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = undiciFetch,
    now = Date.now,
    randomBytesFn = randomBytes,
    randomId = randomUUID,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = {}) {
    if (!accountService || typeof accountService.create !== 'function') {
      throw new TypeError('accountService.create is required');
    }
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (typeof randomBytesFn !== 'function' || typeof randomId !== 'function') {
      throw new TypeError('random byte and id generators are required');
    }
    this.accountService = accountService;
    this.baseUrl = new URL(baseUrl);
    if (this.baseUrl.protocol !== 'https:') throw new TypeError('Freebuff authorization base URL must use HTTPS');
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.randomBytesFn = randomBytesFn;
    this.randomId = randomId;
    this.pollTimeoutMs = safeDuration(pollTimeoutMs, DEFAULT_POLL_TIMEOUT_MS, 'pollTimeoutMs');
    this.pollIntervalMs = safeDuration(pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 'pollIntervalMs');
    this.requestTimeoutMs = safeDuration(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'requestTimeoutMs');
    this.records = new Map();
  }

  #owner(session) {
    const owner = typeof session?.sessionHash === 'string' ? session.sessionHash : '';
    if (!owner) throw new FreebuffAuthorizationError('administrator authentication required', 401, 'ADMIN_UNAUTHORIZED');
    return owner;
  }

  #now() {
    return safeNow(this.now);
  }

  #fingerprintId() {
    const random = this.randomBytesFn(6).toString('base64url').slice(0, 8);
    if (!/^[A-Za-z0-9_-]{8}$/.test(random)) throw new Error('random fingerprint generation failed');
    return `codebuff-cli-${random}`;
  }

  #url(path, query = null) {
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    }
    return url;
  }

  async #request(method, path, { body = undefined, query = null } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const headers = {
        accept: 'application/json',
        'user-agent': BROWSER_USER_AGENT,
      };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await this.fetchImpl(this.#url(path, query), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal,
      });
      const raw = await response.text();
      if (raw.length > MAX_JSON_BYTES) {
        throw new FreebuffAuthorizationError('Freebuff authorization response is too large', 502, 'FREEBUFF_AUTH_RESPONSE_INVALID');
      }
      let data = null;
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch {
          throw new FreebuffAuthorizationError('Freebuff authorization response is invalid', 502, 'FREEBUFF_AUTH_RESPONSE_INVALID');
        }
      }
      return { status: response.status, data };
    } catch (error) {
      if (error instanceof FreebuffAuthorizationError) throw error;
      throw new FreebuffAuthorizationError('Freebuff authorization service is temporarily unavailable', 502, 'FREEBUFF_AUTH_UPSTREAM_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
    }
  }

  #find(id, session) {
    const record = this.records.get(id);
    if (!record || record.owner !== this.#owner(session)) {
      throw new FreebuffAuthorizationError('authorization request not found', 404, 'FREEBUFF_AUTH_NOT_FOUND');
    }
    return record;
  }

  #clearSensitive(record) {
    record.loginUrl = null;
    record.fingerprintId = null;
    record.fingerprintHash = null;
    record.upstreamExpiresAt = null;
  }

  #finish(record, status) {
    record.status = status;
    record.finishedAt = this.#now();
    this.#clearSensitive(record);
  }

  #summary(record) {
    const result = {
      id: record.id,
      status: record.status,
      createdAt: new Date(record.createdAt).toISOString(),
    };
    if (record.status === 'completed' && record.account) result.account = publicAccount(record.account);
    if (record.status === 'pending' && record.retrying) result.retrying = true;
    if (record.status === 'expired') result.message = 'authorization expired; start again';
    if (record.status === 'cancelled') result.message = 'authorization cancelled';
    if (record.status === 'duplicate') result.message = 'this Freebuff account is already managed';
    if (record.status === 'failed') result.message = 'unable to save the authorized Freebuff account';
    return result;
  }

  #appendAudit(record, action, summary, accountId = null) {
    try {
      this.accountService.store?.appendAudit?.({
        actor: record.actor,
        action,
        accountId,
        summary,
      });
    } catch {}
  }

  #cleanup() {
    const now = this.#now();
    for (const record of this.records.values()) {
      if (record.status === 'pending' && now >= record.deadlineAt) {
        this.#finish(record, 'expired');
        this.#appendAudit(record, 'account.authorization_expired', 'Freebuff web authorization expired');
      }
      if (record.status !== 'pending' && record.finishedAt !== null && now - record.finishedAt >= RESULT_RETENTION_MS) {
        this.records.delete(record.id);
      }
    }
  }

  #ensureCapacity() {
    this.#cleanup();
    if (this.records.size < MAX_PENDING_AUTHORIZATIONS) return;
    const removable = [...this.records.values()]
      .filter((record) => record.status !== 'pending')
      .sort((left, right) => left.finishedAt - right.finishedAt)[0];
    if (removable) this.records.delete(removable.id);
    if (this.records.size >= MAX_PENDING_AUTHORIZATIONS) {
      throw new FreebuffAuthorizationError('too many authorization requests are pending', 429, 'FREEBUFF_AUTH_LIMITED');
    }
  }

  async start(session) {
    const owner = this.#owner(session);
    this.#cleanup();
    if ([...this.records.values()].some((record) => record.owner === owner && record.status === 'pending')) {
      throw new FreebuffAuthorizationError('an authorization request is already pending', 409, 'FREEBUFF_AUTH_ALREADY_PENDING');
    }
    this.#ensureCapacity();

    const fingerprintId = this.#fingerprintId();
    const { status, data } = await this.#request('POST', '/api/auth/cli/code', {
      body: { fingerprintId },
    });
    const upstream = objectValue(data);
    if (status !== 200 || !upstream) {
      throw new FreebuffAuthorizationError('could not start Freebuff authorization', 502, 'FREEBUFF_AUTH_START_FAILED');
    }

    const loginUrl = boundedText(upstream.loginUrl, 'loginUrl', 2048, { required: true });
    let parsedLoginUrl;
    try {
      parsedLoginUrl = new URL(loginUrl);
    } catch {
      throw new FreebuffAuthorizationError('Freebuff authorization returned an invalid login URL', 502, 'FREEBUFF_AUTH_RESPONSE_INVALID');
    }
    if (
      parsedLoginUrl.origin !== this.baseUrl.origin
      || parsedLoginUrl.pathname !== '/login'
      || !parsedLoginUrl.searchParams.get('auth_code')
    ) {
      throw new FreebuffAuthorizationError('Freebuff authorization returned an unexpected login URL', 502, 'FREEBUFF_AUTH_RESPONSE_INVALID');
    }

    const fingerprintHash = boundedText(upstream.fingerprintHash, 'fingerprintHash', 512, { required: true });
    const upstreamExpiresAt = boundedText(String(upstream.expiresAt ?? ''), 'expiresAt', 512, { required: true });
    const now = this.#now();
    const record = {
      id: this.randomId(),
      owner,
      actor: session.actor || session.username || 'admin',
      status: 'pending',
      createdAt: now,
      finishedAt: null,
      deadlineAt: now + this.pollTimeoutMs,
      nextPollAt: now,
      retrying: false,
      loginUrl: parsedLoginUrl.toString(),
      fingerprintId,
      fingerprintHash,
      upstreamExpiresAt,
      account: null,
    };
    this.records.set(record.id, record);
    this.#appendAudit(record, 'account.authorization_started', 'Started Freebuff web authorization');
    return {
      authorization: {
        ...this.#summary(record),
        loginUrl: record.loginUrl,
      },
    };
  }

  async #complete(record, data) {
    const user = objectValue(data)?.user;
    if (!objectValue(user)) {
      this.#finish(record, 'failed');
      this.#appendAudit(record, 'account.authorization_failed', 'Freebuff authorization returned an invalid user response');
      return;
    }
    let authToken;
    try {
      authToken = boundedText(user.authToken, 'authToken', 8192, { required: true });
    } catch {
      this.#finish(record, 'failed');
      this.#appendAudit(record, 'account.authorization_failed', 'Freebuff authorization returned an invalid credential');
      return;
    }

    try {
      const account = await this.accountService.create({
        name: displayName(user, record.id),
        email: displayEmail(user),
        authToken,
        enabled: false,
      }, record.actor);
      record.account = publicAccount(account);
      this.#finish(record, 'completed');
      this.#appendAudit(record, 'account.authorization_completed', `Authorized account ${record.account.name}`, record.account.id);
    } catch (error) {
      this.#finish(record, error?.code === 'ACCOUNT_DUPLICATE' ? 'duplicate' : 'failed');
      this.#appendAudit(
        record,
        error?.code === 'ACCOUNT_DUPLICATE' ? 'account.authorization_duplicate' : 'account.authorization_failed',
        error?.code === 'ACCOUNT_DUPLICATE'
          ? 'Authorized Freebuff account is already managed'
          : 'Unable to save authorized Freebuff account',
      );
    }
  }

  async poll(id, session) {
    this.#cleanup();
    const record = this.#find(id, session);
    const now = this.#now();
    if (record.status !== 'pending' || now < record.nextPollAt) {
      return { authorization: this.#summary(record) };
    }
    record.nextPollAt = now + this.pollIntervalMs;
    try {
      const { status, data } = await this.#request('GET', '/api/auth/cli/status', {
        query: {
          fingerprintId: record.fingerprintId,
          fingerprintHash: record.fingerprintHash,
          expiresAt: record.upstreamExpiresAt,
        },
      });
      if (status === 200) {
        await this.#complete(record, data);
      } else if (status === 400) {
        this.#finish(record, 'expired');
        this.#appendAudit(record, 'account.authorization_expired', 'Freebuff web authorization expired');
      } else if (status === 401) {
        record.retrying = false;
      } else {
        record.retrying = true;
      }
    } catch {
      record.retrying = true;
    }
    return { authorization: this.#summary(record) };
  }

  cancel(id, session) {
    this.#cleanup();
    const record = this.#find(id, session);
    if (record.status === 'pending') {
      this.#finish(record, 'cancelled');
      this.#appendAudit(record, 'account.authorization_cancelled', 'Cancelled Freebuff web authorization');
    }
    return { authorization: this.#summary(record) };
  }
}
