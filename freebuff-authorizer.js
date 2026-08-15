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
    throw new FreebuffAuthorizationError('Freebuff authorization response is missing ' + field, 502, 'FREEBUFF_AUTH_RESPONSE_INVALID');
  }
  if (text.length > max || /[\r\n\0]/.test(text)) {
    throw new FreebuffAuthorizationError('Freebuff authorization response has invalid ' + field, 502, 'FREEBUFF_AUTH_RESPONSE_INVALID');
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
  if (upstreamId) return 'Freebuff ' + upstreamId.slice(0, 64);
  return 'Freebuff ' + authorizationId.slice(0, 8);
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
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(name + ' must be a positive integer');
  return parsed;
}

function awaitingUpstream(status) {
  return status === 'starting' || status === 'pending';
}

function inFlight(status) {
  return awaitingUpstream(status) || status === 'completing';
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
    if (!accountService || typeof accountService.create !== 'function' || typeof accountService.delete !== 'function') {
      throw new TypeError('accountService.create and accountService.delete are required');
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
    this.revocationsInProgress = 0;
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
    return 'codebuff-cli-' + random;
  }

  #url(path, query = null) {
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    }
    return url;
  }

  async #request(method, path, { body = undefined, query = null, signal: externalSignal = null } = {}) {
    const controller = new AbortController();
    const abortFromExternal = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abortFromExternal();
    else externalSignal?.addEventListener?.('abort', abortFromExternal, { once: true });
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
      externalSignal?.removeEventListener?.('abort', abortFromExternal);
    }
  }

  #find(id, session) {
    const record = this.records.get(id);
    if (!record || record.owner !== this.#owner(session)) {
      throw new FreebuffAuthorizationError('authorization request not found', 404, 'FREEBUFF_AUTH_NOT_FOUND');
    }
    return record;
  }

  #matches(record, generation, status) {
    return record.generation === generation && record.status === status;
  }

  #clearSensitive(record) {
    record.loginUrl = null;
    record.fingerprintId = null;
    record.fingerprintHash = null;
    record.upstreamExpiresAt = null;
  }

  #finish(record, status) {
    if (!inFlight(record.status)) return false;
    record.generation += 1;
    record.status = status;
    record.finishedAt = this.#now();
    record.terminationStatus = null;
    const startController = record.startController;
    const pollController = record.pollController;
    this.#clearPollTimer(record);
    record.startController = null;
    record.pollController = null;
    this.#clearSensitive(record);
    startController?.abort();
    pollController?.abort();
    return true;
  }

  #expire(record) {
    if (record.status === 'completing') {
      record.terminationStatus ||= 'expired';
      return;
    }
    if (this.#finish(record, 'expired')) {
      this.#appendAudit(record, 'account.authorization_expired', 'Freebuff web authorization expired');
    }
  }

  #summary(record) {
    const result = {
      id: record.id,
      status: record.status,
      createdAt: new Date(record.createdAt).toISOString(),
    };
    if (record.status === 'completed' && record.account) result.account = publicAccount(record.account);
    if (record.status === 'pending' && record.retrying) result.retrying = true;
    if (record.status === 'starting') result.message = 'preparing authorization link';
    if (record.status === 'completing') result.message = 'saving authorized account';
    if (record.status === 'expired') result.message = 'authorization expired; start again';
    if (record.status === 'cancelled') result.message = 'authorization cancelled';
    if (record.status === 'duplicate') result.message = 'this Freebuff account is already managed';
    if (record.status === 'failed') result.message = 'unable to save the authorized Freebuff account';
    return result;
  }

  #details(record) {
    const authorization = this.#summary(record);
    if (record.status === 'pending' && record.loginUrl) authorization.loginUrl = record.loginUrl;
    return { authorization };
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
      if (awaitingUpstream(record.status) && now >= record.deadlineAt) this.#expire(record);
      if (record.status === 'completing' && now >= record.deadlineAt) record.terminationStatus ||= 'expired';
      if (!inFlight(record.status) && record.finishedAt !== null && now - record.finishedAt >= RESULT_RETENTION_MS) {
        this.records.delete(record.id);
      }
    }
  }

  #ensureCapacity() {
    this.#cleanup();
    if (this.records.size < MAX_PENDING_AUTHORIZATIONS) return;
    const removable = [...this.records.values()]
      .filter((record) => !inFlight(record.status))
      .sort((left, right) => left.finishedAt - right.finishedAt)[0];
    if (removable) this.records.delete(removable.id);
    if (this.records.size >= MAX_PENDING_AUTHORIZATIONS) {
      throw new FreebuffAuthorizationError('too many authorization requests are pending', 429, 'FREEBUFF_AUTH_LIMITED');
    }
  }

  #deadlineAt(session, now) {
    const sessionExpiresAt = Number(session?.expiresAt) * 1000;
    const sessionDeadline = Number.isFinite(sessionExpiresAt) ? sessionExpiresAt : Number.POSITIVE_INFINITY;
    return Math.min(now + this.pollTimeoutMs, sessionDeadline);
  }

  #clearPollTimer(record) {
    if (record.pollTimer) clearTimeout(record.pollTimer);
    record.pollTimer = null;
  }

  #schedulePoll(record, delayMs = this.pollIntervalMs) {
    if (record.status !== 'pending') return;
    this.#clearPollTimer(record);
    const delay = Math.max(1, Math.min(Number(delayMs) || this.pollIntervalMs, 2_147_483_647));
    const timer = setTimeout(() => {
      if (record.pollTimer === timer) record.pollTimer = null;
      void this.#pollRecord(record, { scheduled: true }).catch(() => {});
    }, delay);
    timer.unref?.();
    record.pollTimer = timer;
  }

  #launchStart(record) {
    let promise;
    promise = this.#beginStart(record)
      .catch(() => {
        if (awaitingUpstream(record.status)) {
          this.#finish(record, 'failed');
          this.#appendAudit(record, 'account.authorization_failed', 'Unable to prepare Freebuff web authorization');
        }
      })
      .finally(() => {
        if (record.startPromise === promise) record.startPromise = null;
      });
    record.startPromise = promise;
  }

  async #beginStart(record) {
    const generation = record.generation;
    const controller = new AbortController();
    record.startController = controller;
    try {
      const { status, data } = await this.#request('POST', '/api/auth/cli/code', {
        body: { fingerprintId: record.fingerprintId },
        signal: controller.signal,
      });
      if (!this.#matches(record, generation, 'starting')) return;
      const upstream = objectValue(data);
      if (status !== 200 || !upstream) {
        this.#finish(record, 'failed');
        this.#appendAudit(record, 'account.authorization_failed', 'Unable to prepare Freebuff web authorization');
        return;
      }

      const loginUrl = boundedText(upstream.loginUrl, 'loginUrl', 2048, { required: true });
      let parsedLoginUrl;
      try {
        parsedLoginUrl = new URL(loginUrl);
      } catch {
        this.#finish(record, 'failed');
        this.#appendAudit(record, 'account.authorization_failed', 'Freebuff authorization returned an invalid login URL');
        return;
      }
      if (
        parsedLoginUrl.origin !== this.baseUrl.origin
        || parsedLoginUrl.pathname !== '/login'
        || !parsedLoginUrl.searchParams.get('auth_code')
      ) {
        this.#finish(record, 'failed');
        this.#appendAudit(record, 'account.authorization_failed', 'Freebuff authorization returned an unexpected login URL');
        return;
      }

      const fingerprintHash = boundedText(upstream.fingerprintHash, 'fingerprintHash', 512, { required: true });
      const upstreamExpiresAt = boundedText(String(upstream.expiresAt ?? ''), 'expiresAt', 512, { required: true });
      if (!this.#matches(record, generation, 'starting')) return;
      if (this.#now() >= record.deadlineAt) {
        this.#expire(record);
        return;
      }
      record.loginUrl = parsedLoginUrl.toString();
      record.fingerprintHash = fingerprintHash;
      record.upstreamExpiresAt = upstreamExpiresAt;
      record.retrying = false;
      record.nextPollAt = this.#now();
      record.status = 'pending';
      record.generation += 1;
      this.#schedulePoll(record);
    } catch {
      if (this.#matches(record, generation, 'starting')) {
        this.#finish(record, 'failed');
        this.#appendAudit(record, 'account.authorization_failed', 'Freebuff web authorization service is temporarily unavailable');
      }
    } finally {
      if (record.startController === controller) record.startController = null;
    }
  }

  async start(session) {
    if (this.revocationsInProgress > 0) {
      throw new FreebuffAuthorizationError(
        'authorization is temporarily unavailable while administrator sessions are being revoked',
        503,
        'FREEBUFF_AUTH_REVOCATION_IN_PROGRESS',
      );
    }
    const owner = this.#owner(session);
    this.#cleanup();
    const existing = [...this.records.values()].find((record) => record.owner === owner && inFlight(record.status));
    if (existing) return this.#details(existing);
    this.#ensureCapacity();

    const now = this.#now();
    const deadlineAt = this.#deadlineAt(session, now);
    if (deadlineAt <= now) {
      throw new FreebuffAuthorizationError('administrator session has expired', 401, 'ADMIN_UNAUTHORIZED');
    }
    const record = {
      id: this.randomId(),
      owner,
      actor: session.actor || session.username || 'admin',
      status: 'starting',
      createdAt: now,
      finishedAt: null,
      deadlineAt,
      nextPollAt: now,
      retrying: false,
      loginUrl: null,
      fingerprintId: this.#fingerprintId(),
      fingerprintHash: null,
      upstreamExpiresAt: null,
      account: null,
      generation: 1,
      terminationStatus: null,
      startPromise: null,
      startController: null,
      pollPromise: null,
      pollController: null,
      pollTimer: null,
    };
    this.records.set(record.id, record);
    this.#appendAudit(record, 'account.authorization_started', 'Started Freebuff web authorization');
    this.#launchStart(record);
    return this.#details(record);
  }

  async #complete(record, data, generation) {
    if (!this.#matches(record, generation, 'pending')) return;
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
    if (!this.#matches(record, generation, 'pending')) return;
    if (this.#now() >= record.deadlineAt) {
      this.#expire(record);
      return;
    }

    record.status = 'completing';
    record.generation += 1;
    const completionGeneration = record.generation;
    try {
      const account = await this.accountService.create({
        name: displayName(user, record.id),
        email: displayEmail(user),
        authToken,
        enabled: false,
      }, record.actor);
      if (!this.#matches(record, completionGeneration, 'completing')) return;
      if (this.#now() >= record.deadlineAt) record.terminationStatus ||= 'expired';
      if (record.terminationStatus) {
        const terminalStatus = record.terminationStatus;
        try {
          await this.accountService.delete(account.id, record.actor);
          if (!this.#matches(record, completionGeneration, 'completing')) return;
          this.#finish(record, terminalStatus);
          this.#appendAudit(
            record,
            terminalStatus === 'expired' ? 'account.authorization_expired' : 'account.authorization_cancelled',
            terminalStatus === 'expired'
              ? 'Freebuff web authorization expired before the account could be saved'
              : 'Cancelled Freebuff web authorization before the account could be saved',
          );
        } catch {
          if (this.#matches(record, completionGeneration, 'completing')) {
            this.#finish(record, 'failed');
            this.#appendAudit(record, 'account.authorization_failed', 'Unable to roll back an interrupted Freebuff authorization');
          }
        }
        return;
      }
      record.account = publicAccount(account);
      this.#finish(record, 'completed');
      this.#appendAudit(record, 'account.authorization_completed', 'Authorized account ' + record.account.name, record.account.id);
    } catch (error) {
      if (!this.#matches(record, completionGeneration, 'completing')) return;
      if (this.#now() >= record.deadlineAt) record.terminationStatus ||= 'expired';
      const terminalStatus = record.terminationStatus || (error?.code === 'ACCOUNT_DUPLICATE' ? 'duplicate' : 'failed');
      this.#finish(record, terminalStatus);
      this.#appendAudit(
        record,
        terminalStatus === 'cancelled'
          ? 'account.authorization_cancelled'
          : terminalStatus === 'expired'
            ? 'account.authorization_expired'
            : error?.code === 'ACCOUNT_DUPLICATE'
              ? 'account.authorization_duplicate'
              : 'account.authorization_failed',
        terminalStatus === 'cancelled'
          ? 'Cancelled Freebuff web authorization'
          : terminalStatus === 'expired'
            ? 'Freebuff web authorization expired'
            : error?.code === 'ACCOUNT_DUPLICATE'
              ? 'Authorized Freebuff account is already managed'
              : 'Unable to save authorized Freebuff account',
      );
    }
  }

  async #pollRecord(record, { scheduled = false } = {}) {
    const now = this.#now();
    if (record.status !== 'pending') return this.#details(record);
    if (now >= record.deadlineAt) {
      this.#expire(record);
      return this.#details(record);
    }
    if (record.pollPromise) return record.pollPromise;
    if (!scheduled && now < record.nextPollAt) return this.#details(record);

    this.#clearPollTimer(record);
    const generation = record.generation;
    const controller = new AbortController();
    const pollPromise = (async () => {
      record.nextPollAt = this.#now() + this.pollIntervalMs;
      record.pollController = controller;
      try {
        const { status, data } = await this.#request('GET', '/api/auth/cli/status', {
          query: {
            fingerprintId: record.fingerprintId,
            fingerprintHash: record.fingerprintHash,
            expiresAt: record.upstreamExpiresAt,
          },
          signal: controller.signal,
        });
        if (!this.#matches(record, generation, 'pending')) return this.#details(record);
        if (this.#now() >= record.deadlineAt) {
          this.#expire(record);
        } else if (status === 200) {
          await this.#complete(record, data, generation);
        } else if (status === 400) {
          this.#expire(record);
        } else if (status === 401) {
          record.retrying = false;
        } else {
          record.retrying = true;
        }
      } catch {
        if (this.#matches(record, generation, 'pending')) record.retrying = true;
      } finally {
        if (record.pollController === controller) record.pollController = null;
      }
      return this.#details(record);
    })();
    record.pollPromise = pollPromise;

    try {
      return await pollPromise;
    } finally {
      if (record.pollPromise === pollPromise) {
        record.pollPromise = null;
        if (record.status === 'pending') this.#schedulePoll(record);
      }
    }
  }

  async poll(id, session) {
    this.#cleanup();
    const record = this.#find(id, session);
    return this.#pollRecord(record);
  }

  async #terminate(record, status, summary) {
    if (record.status === 'completing') {
      record.terminationStatus ||= status;
      if (record.pollPromise) await record.pollPromise;
      return this.#details(record);
    }
    if (awaitingUpstream(record.status) && this.#finish(record, status)) {
      this.#appendAudit(record, status === 'expired' ? 'account.authorization_expired' : 'account.authorization_cancelled', summary);
    }
    return this.#details(record);
  }

  async cancel(id, session) {
    this.#cleanup();
    const record = this.#find(id, session);
    return this.#terminate(record, 'cancelled', 'Cancelled Freebuff web authorization');
  }

  async cancelBySession(session) {
    const owner = this.#owner(session);
    this.revocationsInProgress += 1;
    try {
      this.#cleanup();
      const records = [...this.records.values()].filter((record) => record.owner === owner && inFlight(record.status));
      await Promise.all(records.map((record) => this.#terminate(record, 'cancelled', 'Cancelled Freebuff web authorization after administrator session revocation')));
      return { cancelled: records.length };
    } finally {
      this.revocationsInProgress -= 1;
    }
  }

  async cancelAll() {
    this.revocationsInProgress += 1;
    try {
      this.#cleanup();
      const records = [...this.records.values()].filter((record) => inFlight(record.status));
      await Promise.all(records.map((record) => this.#terminate(record, 'cancelled', 'Cancelled Freebuff web authorization after administrator session revocation')));
      return { cancelled: records.length };
    } finally {
      this.revocationsInProgress -= 1;
    }
  }
}
