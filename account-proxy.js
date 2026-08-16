import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { basename, resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import { fetch as undiciFetch, Pool, ProxyAgent } from 'undici';
import { socksDispatcher } from 'fetch-socks';

const DEFAULT_PROTECTED_HOSTS = ['codebuff.com', 'www.codebuff.com'];
const PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);
const SAFE_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
]);
const TIMEOUT_NETWORK_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);
const DEFAULT_CODEBUFF_API = 'https://www.codebuff.com';

export class AccountProxyConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AccountProxyConfigError';
  }
}

export class AccountProxyRequestError extends Error {
  constructor(message, code = 'ACCOUNT_PROXY_ERROR') {
    super(message);
    this.name = 'AccountProxyRequestError';
    this.code = code;
  }
}

function configError(source, message) {
  return new AccountProxyConfigError(`${source}: ${message}`);
}

function parseCredentialBoolean(value, source, field) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw configError(source, `${field} must be true or false`);
  return value;
}

export function parseEnvBoolean(value, defaultValue = false, name = 'value') {
  if (value === undefined || value === null || String(value).trim() === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new AccountProxyConfigError(`${name} must be true or false`);
}

export function normalizeTokenEntry(value, source) {
  if (typeof value !== 'string' || value.trim().length <= 8) {
    throw configError(source, 'authToken is missing or invalid');
  }
  const tokenEntry = value.trim();
  if (/[\r\n,]/.test(tokenEntry)) {
    throw configError(source, 'authToken cannot contain commas or line breaks');
  }
  const separator = tokenEntry.indexOf(':');
  const token = separator > 0 ? tokenEntry.slice(0, separator).trim() : tokenEntry;
  if (token.length <= 8) throw configError(source, 'authToken is missing or invalid');
  return { token, tokenEntry };
}

function normalizeProxyUrl(value, source) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw configError(source, 'proxyUrl must be a URL string');

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw configError(source, 'proxyUrl is not a valid URL');
  }

  if (!PROXY_PROTOCOLS.has(url.protocol)) {
    throw configError(source, 'proxyUrl must use http, https, socks5, or socks5h');
  }
  if (!url.hostname) throw configError(source, 'proxyUrl must include a hostname');
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw configError(source, 'proxyUrl cannot include a path, query, or fragment');
  }

  const defaultPort = url.protocol === 'http:' ? 80 : url.protocol === 'https:' ? 443 : 1080;
  const port = url.port ? Number.parseInt(url.port, 10) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw configError(source, 'proxyUrl contains an invalid port');
  }

  let username;
  let password;
  try {
    username = decodeURIComponent(url.username || '');
    password = decodeURIComponent(url.password || '');
  } catch {
    throw configError(source, 'proxyUrl credentials must be URL-encoded');
  }

  return {
    protocol: url.protocol === 'socks5h:' ? 'socks5:' : url.protocol,
    hostname: url.hostname.replace(/^\[|\]$/g, ''),
    port,
    username,
    password,
  };
}

export function createAccountRoute({
  token,
  tokenEntry = token,
  source = 'account',
  proxyUrl,
  proxyRequired = false,
}) {
  const normalized = normalizeTokenEntry(tokenEntry, source);
  const suppliedToken = normalizeTokenEntry(token, source).token;
  if (suppliedToken !== normalized.token) {
    throw configError(source, 'token and tokenEntry refer to different accounts');
  }
  if (typeof proxyRequired !== 'boolean') {
    throw configError(source, 'proxyRequired must be true or false');
  }
  const proxy = normalizeProxyUrl(proxyUrl, source);
  if (proxyRequired && !proxy) {
    throw configError(source, 'proxyRequired is true but proxyUrl is missing');
  }
  return {
    token: normalized.token,
    tokenEntry: normalized.tokenEntry,
    source,
    proxy,
    proxyRequired,
  };
}

function credentialRecord(value, source, fallbackName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configError(source, 'account must be one JSON object');
  }
  const normalized = normalizeTokenEntry(value.authToken, source);
  const proxyRequired = parseCredentialBoolean(value.proxyRequired, source, 'proxyRequired');
  const enabled = value.enabled === undefined
    ? true
    : parseCredentialBoolean(value.enabled, source, 'enabled');
  if (value.name !== undefined && typeof value.name !== 'string') {
    throw configError(source, 'name must be a string');
  }
  if (value.email !== undefined && typeof value.email !== 'string') {
    throw configError(source, 'email must be a string');
  }
  normalizeProxyUrl(value.proxyUrl, source);
  return {
    source,
    name: value.name?.trim() || fallbackName,
    email: value.email?.trim() || '',
    authToken: normalized.tokenEntry,
    token: normalized.token,
    proxyUrl: typeof value.proxyUrl === 'string' ? value.proxyUrl.trim() : null,
    proxyRequired,
    enabled,
  };
}

export function loadCredentialRecords(credentialDirectory) {
  if (!existsSync(credentialDirectory)) return [];

  const records = [];
  const seenTokens = new Map();
  const files = readdirSync(credentialDirectory).filter((file) => file.endsWith('.json')).sort();

  for (const file of files) {
    const source = basename(file);
    let parsed;
    try {
      const raw = readFileSync(resolve(credentialDirectory, file), 'utf8').replace(/^\uFEFF/, '');
      parsed = JSON.parse(raw);
    } catch {
      throw configError(source, 'credential file is not valid JSON');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw configError(source, 'credential file must contain one JSON object');
    }

    const fileRecords = [];
    if (parsed.accounts !== undefined && !parsed.authToken) {
      if (!parsed.accounts || typeof parsed.accounts !== 'object' || Array.isArray(parsed.accounts)) {
        throw configError(source, 'accounts must be an object');
      }
      for (const [key, account] of Object.entries(parsed.accounts)) {
        fileRecords.push(credentialRecord(account, `${source}:${key}`, key));
      }
    } else {
      fileRecords.push(credentialRecord(parsed, source, source.replace(/\.json$/i, '')));
    }

    for (const record of fileRecords) {
      if (seenTokens.has(record.token)) {
        throw configError(record.source, `duplicates the authToken from ${seenTokens.get(record.token)}`);
      }
      seenTokens.set(record.token, record.source);
      records.push(record);
    }
  }

  return records;
}

export function loadCredentialAccounts(credentialDirectory) {
  return loadCredentialRecords(credentialDirectory)
    .filter((record) => record.enabled)
    .map((record) => ({
      ...createAccountRoute({
        token: record.token,
        tokenEntry: record.authToken,
        source: record.source,
        proxyUrl: record.proxyUrl,
        proxyRequired: record.proxyRequired,
      }),
      name: record.name,
      email: record.email,
    }));
}

export function parseTokenEntries(value) {
  return String(value || '')
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((tokenEntry) => normalizeTokenEntry(tokenEntry, 'FREEBUFF_TOKEN'));
}

export function parseProtectedHosts(value) {
  const entries = String(value || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...DEFAULT_PROTECTED_HOSTS, ...entries]);
}

function createDispatcher(proxy, connectTimeoutMs) {
  if (proxy.protocol === 'http:' || proxy.protocol === 'https:') {
    const uri = new URL(`${proxy.protocol}//${proxy.hostname.includes(':') ? `[${proxy.hostname}]` : proxy.hostname}:${proxy.port}`);
    const token = proxy.username || proxy.password
      ? `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`
      : undefined;
    return {
      kind: proxy.protocol.slice(0, -1),
      dispatcher: new ProxyAgent({
        uri: uri.toString(),
        token,
        proxyTunnel: true,
        proxyTls: { timeout: connectTimeoutMs },
        requestTls: { timeout: connectTimeoutMs },
        clientFactory: (origin, options) => new ConnectTimeoutPool(
          origin,
          options,
          connectTimeoutMs,
        ),
      }),
    };
  }

  return {
    kind: 'socks5',
    dispatcher: socksDispatcher({
      type: 5,
      host: proxy.hostname,
      port: proxy.port,
      userId: proxy.username || undefined,
      password: proxy.password || undefined,
    }, {
      connect: { timeout: connectTimeoutMs },
    }),
  };
}

class ConnectTimeoutPool extends Pool {
  constructor(origin, options, connectTimeoutMs) {
    super(origin, options);
    this.connectTimeoutMs = connectTimeoutMs;
  }

  connect(options) {
    const timeoutSignal = AbortSignal.timeout(this.connectTimeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    return super.connect({ ...options, signal });
  }
}

function requestUrl(input) {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return input;
  if (input && typeof input.url === 'string') return new URL(input.url);
  throw new TypeError('Unsupported fetch input');
}

function normalizeFetchArguments(input, init) {
  if (typeof input === 'string' || input instanceof URL) {
    return { input, init: init || undefined };
  }
  if (!input || typeof input.url !== 'string') {
    throw new TypeError('Unsupported fetch input');
  }

  const inherited = {};
  for (const field of [
    'method',
    'headers',
    'body',
    'cache',
    'credentials',
    'integrity',
    'keepalive',
    'mode',
    'redirect',
    'referrer',
    'referrerPolicy',
    'signal',
  ]) {
    if (input[field] !== undefined) inherited[field] = input[field];
  }
  if (inherited.body) inherited.duplex = input.duplex || 'half';
  const overrides = Object.fromEntries(
    Object.entries(init || {}).filter(([, value]) => value !== undefined),
  );
  return { input: input.url, init: { ...inherited, ...overrides } };
}

function requestAuthorization(input, init) {
  try {
    if (init && Object.prototype.hasOwnProperty.call(init, 'headers') && init.headers !== undefined) {
      return new Headers(init.headers).get('authorization');
    }
    if (input && typeof input === 'object' && input.headers) {
      return new Headers(input.headers).get('authorization');
    }
  } catch {
    return null;
  }
  return null;
}

function bearerToken(input, init) {
  const authorization = requestAuthorization(input, init);
  const match = typeof authorization === 'string' ? /^Bearer\s+(.+)$/i.exec(authorization.trim()) : null;
  return match ? match[1].trim() : null;
}

function sanitizedConnectionError(error, mode) {
  const subject = mode === 'direct' ? 'direct connection' : 'account proxy request';
  const errorNames = new Set([error?.name, error?.cause?.name]);
  if (errorNames.has('AbortError')) {
    const safe = new AccountProxyRequestError(`${subject} aborted`, 'ABORT_ERR');
    safe.name = 'AbortError';
    return safe;
  }
  const rawCode = error?.code || error?.cause?.code;
  if (
    errorNames.has('TimeoutError')
    || errorNames.has('ConnectTimeoutError')
    || TIMEOUT_NETWORK_CODES.has(rawCode)
  ) {
    const safe = new AccountProxyRequestError(`${subject} timed out`, 'ETIMEDOUT');
    safe.name = 'TimeoutError';
    return safe;
  }

  const code = SAFE_NETWORK_CODES.has(rawCode)
    ? rawCode
    : mode === 'direct' ? 'ACCOUNT_CONNECTION_ERROR' : 'ACCOUNT_PROXY_ERROR';
  return new AccountProxyRequestError(`${subject} failed (${code})`, code);
}

export async function probeAccountConnection(account, options = {}) {
  const connectTimeoutMs = options.connectTimeoutMs ?? 10000;
  const testUrl = options.testUrl || 'https://www.codebuff.com/';
  const fetchImpl = options.fetchImpl || undiciFetch;
  const mode = account?.proxy ? 'proxy' : 'direct';
  let created = null;
  const startedAt = Date.now();
  try {
    if (account?.proxy) created = createDispatcher(account.proxy, connectTimeoutMs);
    const requestInit = {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(connectTimeoutMs),
    };
    if (created) requestInit.dispatcher = created.dispatcher;
    const response = await fetchImpl(testUrl, requestInit);
    try { await response.body?.cancel(); } catch {}
    return {
      ok: true,
      mode,
      httpStatus: response.status,
      latencyMs: Date.now() - startedAt,
      message: mode === 'proxy'
        ? 'proxy reached the fixed upstream target'
        : 'direct connection reached the fixed upstream target',
    };
  } catch (error) {
    const safe = sanitizedConnectionError(error, mode);
    return {
      ok: false,
      mode,
      code: safe.code,
      latencyMs: Date.now() - startedAt,
      message: safe.message,
    };
  } finally {
    try { await created?.dispatcher.close?.(); } catch {}
  }
}

export async function probeAccountProxy(account, options = {}) {
  if (!account?.proxy) {
    throw new AccountProxyRequestError('account proxy route is unavailable', 'ACCOUNT_PROXY_REQUIRED');
  }
  return probeAccountConnection(account, options);
}

// A proxy test has two deliberately separate stages.  There is no portable
// "ping a proxy" operation in HTTP/SOCKS, so stage one performs a request to
// a neutral connectivity target.  Stage two uses the same dispatcher against
// the fixed Freebuff origin.  Keeping the dispatcher alive between stages is
// important: it verifies the actual route that the account will use.
export async function probeAccountProxyStages(account, options = {}) {
  if (!account?.proxy) {
    throw new AccountProxyRequestError('account proxy route is unavailable', 'ACCOUNT_PROXY_REQUIRED');
  }
  const connectTimeoutMs = options.connectTimeoutMs ?? 10000;
  const proxyTestUrl = options.proxyTestUrl || 'https://www.cloudflare.com/';
  const freebuffTestUrl = options.freebuffTestUrl || 'https://www.codebuff.com/';
  const fetchImpl = options.fetchImpl || undiciFetch;
  let created = null;
  const startedAt = Date.now();
  const stages = {};

  const runStage = async (name, url) => {
    const stageStartedAt = Date.now();
    try {
      const requestInit = {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(connectTimeoutMs),
        dispatcher: created.dispatcher,
      };
      const response = await fetchImpl(url, requestInit);
      try { await response.body?.cancel(); } catch {}
      const ok = response.status >= 200 && response.status < 400;
      const result = {
        ok,
        reachable: true,
        httpStatus: response.status,
        latencyMs: Date.now() - stageStartedAt,
        ...(ok ? {
          message: name === 'proxy'
            ? 'proxy connection established'
            : 'proxy reached the Freebuff origin',
        } : {
          code: response.status === 407
            ? 'ACCOUNT_PROXY_AUTH_FAILED'
            : name === 'proxy'
              ? 'ACCOUNT_PROXY_TARGET_REJECTED'
              : 'FREEBUFF_TARGET_REJECTED',
          message: name === 'proxy'
            ? `proxy test target returned HTTP ${response.status}`
            : `Freebuff returned HTTP ${response.status}`,
        }),
      };
      stages[name] = result;
      return result;
    } catch (error) {
      const safe = sanitizedConnectionError(error, 'proxy');
      const result = {
        ok: false,
        code: safe.code,
        latencyMs: Date.now() - stageStartedAt,
        message: name === 'proxy'
          ? safe.message
          : `Freebuff request failed (${safe.code})`,
      };
      stages[name] = result;
      return result;
    }
  };

  try {
    created = createDispatcher(account.proxy, connectTimeoutMs);
    const proxy = await runStage('proxy', proxyTestUrl);
    if (!proxy.ok) {
      stages.freebuff = {
        ok: false,
        skipped: true,
        message: 'skipped because the proxy connection failed',
      };
      return {
        ok: false,
        mode: 'proxy',
        stage: 'proxy',
        stages,
        latencyMs: Date.now() - startedAt,
        message: proxy.message,
      };
    }
    const freebuff = await runStage('freebuff', freebuffTestUrl);
    return {
      ok: freebuff.ok,
      mode: 'proxy',
      stage: 'freebuff',
      stages,
      httpStatus: freebuff.httpStatus || null,
      latencyMs: Date.now() - startedAt,
      message: freebuff.ok ? 'proxy reached the Freebuff origin' : freebuff.message,
    };
  } finally {
    try { await created?.dispatcher.close?.(); } catch {}
  }
}

function boundedRetryAfterMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(Math.round(parsed), 6 * 60 * 60 * 1000);
}

function retryAfterFromResponse(response, payload) {
  const fromPayload = boundedRetryAfterMs(payload?.retryAfterMs);
  if (fromPayload) return fromPayload;

  const retryAfter = response.headers.get('retry-after');
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return boundedRetryAfterMs(seconds * 1000);
  const retryAt = Date.parse(retryAfter);
  return Number.isFinite(retryAt) ? boundedRetryAfterMs(retryAt - Date.now()) : null;
}

// The session endpoint is Freebuff's documented read-only account check. It
// intentionally does not create a session or send a model request. A dedicated
// router keeps this probe on the account's configured proxy without relying on
// the process-wide fetch router or falling back to a direct request.
export async function probeAccountRecovery(account, options = {}) {
  if (!account?.token || !account?.tokenEntry) {
    throw new AccountProxyConfigError('account recovery probe requires a token route');
  }
  const connectTimeoutMs = options.connectTimeoutMs ?? 10000;
  const upstreamBaseUrl = options.upstreamBaseUrl || DEFAULT_CODEBUFF_API;
  const fetchImpl = options.fetchImpl || undiciFetch;
  const startedAt = Date.now();
  let router = null;

  try {
    const endpoint = new URL('/api/v1/freebuff/session', upstreamBaseUrl).toString();
    router = createAccountProxyRouter([account], {
      requireProxy: options.requireProxy === undefined
        ? Boolean(account.proxyRequired)
        : Boolean(options.requireProxy),
      protectedHosts: options.protectedHosts,
      connectTimeoutMs,
      fetchImpl,
    });
    const response = await router.fetch(endpoint, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${account.token}`,
        'x-freebuff-include-unused-rate-limits': '1',
      },
      signal: AbortSignal.timeout(connectTimeoutMs),
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch {}
    const upstreamState = typeof payload?.status === 'string'
      ? payload.status
      : typeof payload?.state === 'string' ? payload.state : null;
    const retryAfterMs = retryAfterFromResponse(response, payload);
    const result = {
      ok: false,
      recovered: false,
      state: 'unknown',
      httpStatus: response.status,
      latencyMs: Date.now() - startedAt,
      retryAfterMs,
      message: 'Freebuff returned an unrecognized recovery response',
    };

    if (response.status === 429 || upstreamState === 'rate_limited') {
      return {
        ...result,
        state: 'rate_limited',
        message: 'Freebuff still reports this account as rate limited',
      };
    }
    if (response.status === 401) {
      return { ...result, state: 'token_invalid', message: 'Freebuff rejected this account token' };
    }
    if (response.status === 403) {
      const state = upstreamState === 'banned'
        ? 'banned'
        : upstreamState === 'country_blocked' ? 'country_blocked' : 'blocked';
      return { ...result, state, message: `Freebuff denied this account (${state})` };
    }
    if (response.status >= 500) {
      return { ...result, state: 'upstream_error', message: `Freebuff recovery check returned HTTP ${response.status}` };
    }
    if (['model_locked', 'ip_capped'].includes(upstreamState)) {
      return { ...result, state: upstreamState, message: `Freebuff recovery check is not ready (${upstreamState})` };
    }
    // Freebuff returns 404 when the token is valid but has no active session.
    // A 2xx session state is equally valid unless it explicitly says otherwise.
    if ((response.status >= 200 && response.status < 300) || response.status === 404) {
      return {
        ...result,
        ok: true,
        recovered: true,
        state: 'recovered',
        message: response.status === 404
          ? 'Freebuff accepted the account; no active session is present'
          : 'Freebuff accepted the account',
      };
    }
    return result;
  } catch (error) {
    if (error instanceof AccountProxyConfigError) {
      return {
        ok: false,
        recovered: false,
        state: 'proxy_unavailable',
        code: 'ACCOUNT_PROXY_REQUIRED',
        latencyMs: Date.now() - startedAt,
        retryAfterMs: null,
        message: 'account proxy routing is unavailable for the recovery check',
      };
    }
    const safe = error instanceof AccountProxyRequestError
      ? error
      : sanitizedConnectionError(error, account.proxy ? 'proxy' : 'direct');
    return {
      ok: false,
      recovered: false,
      state: safe.code === 'ACCOUNT_PROXY_REQUIRED' ? 'proxy_unavailable' : 'network_error',
      code: safe.code,
      latencyMs: Date.now() - startedAt,
      retryAfterMs: null,
      message: safe.message,
    };
  } finally {
    try { await router?.close?.(); } catch {}
  }
}

export function createAccountProxyRouter(accounts, options = {}) {
  const requireProxy = Boolean(options.requireProxy);
  const connectTimeoutMs = options.connectTimeoutMs ?? 10000;
  if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs < 1) {
    throw new AccountProxyConfigError('connectTimeoutMs must be a positive integer');
  }
  const fetchImpl = options.fetchImpl || undiciFetch;
  const protectedHosts = options.protectedHosts || new Set(DEFAULT_PROTECTED_HOSTS);
  const routes = new Map();
  const dispatchers = [];
  const proxyKinds = { http: 0, https: 0, socks5: 0 };

  for (const account of accounts) {
    if (routes.has(account.token)) {
      throw new AccountProxyConfigError(`${account.source || 'account'}: duplicate authToken route`);
    }
    if (!account.proxy && (requireProxy || account.proxyRequired)) {
      throw new AccountProxyConfigError(`${account.source || 'account'}: account proxy is required but proxyUrl is missing`);
    }

    let dispatcher = null;
    let kind = null;
    if (account.proxy) {
      const created = createDispatcher(account.proxy, connectTimeoutMs);
      dispatcher = created.dispatcher;
      kind = created.kind;
      dispatchers.push(dispatcher);
      proxyKinds[kind] += 1;
    }
    routes.set(account.token, { dispatcher, kind, proxyRequired: account.proxyRequired });
  }

  const routedFetch = async (input, init) => {
    const url = requestUrl(input);
    const token = bearerToken(input, init);
    const route = token ? routes.get(token) : null;
    const protectedTarget = protectedHosts.has(url.hostname.toLowerCase());
    const normalized = normalizeFetchArguments(input, init);
    const routingActive = dispatchers.length > 0 || requireProxy;

    if (route?.dispatcher) {
      try {
        return await fetchImpl(normalized.input, { ...(normalized.init || {}), dispatcher: route.dispatcher });
      } catch (error) {
        throw sanitizedConnectionError(error, 'proxy');
      }
    }

    if (route && (requireProxy || route.proxyRequired)) {
      throw new AccountProxyRequestError('account proxy route is unavailable', 'ACCOUNT_PROXY_REQUIRED');
    }
    if (!route && routingActive && (token || protectedTarget)) {
      throw new AccountProxyRequestError('outbound Freebuff request has no account proxy route', 'ACCOUNT_PROXY_REQUIRED');
    }

    return fetchImpl(normalized.input, normalized.init);
  };

  const close = async () => {
    await Promise.allSettled(dispatchers.map((dispatcher) => dispatcher.close?.()));
  };

  return {
    fetch: routedFetch,
    close,
    stats: {
      accounts: routes.size,
      proxiedAccounts: dispatchers.length,
      directAccounts: routes.size - dispatchers.length,
      proxyKinds,
      requireProxy,
    },
  };
}

export function installAccountProxyFetch(accounts, options = {}) {
  const previousFetch = globalThis.fetch;
  const router = createAccountProxyRouter(accounts, options);
  const installed = router.stats.proxiedAccounts > 0 || router.stats.requireProxy;
  if (installed) globalThis.fetch = router.fetch;
  return {
    ...router,
    installed,
    restore() {
      if (globalThis.fetch === router.fetch) globalThis.fetch = previousFetch;
    },
  };
}

export function installReloadableAccountProxyFetch(accounts, options = {}) {
  const previousFetch = globalThis.fetch;
  const routerContext = new AsyncLocalStorage();
  const retireMs = options.retireMs ?? 300000;
  if (!Number.isInteger(retireMs) || retireMs < 0) {
    throw new AccountProxyConfigError('retireMs must be a non-negative integer');
  }

  const routerOptions = { ...options };
  delete routerOptions.retireMs;
  const makeHandle = (router) => ({
    router,
    leases: 0,
    retired: false,
    closeWhenReleased: false,
    closeStarted: false,
    closePromise: null,
    timer: null,
  });
  let current = makeHandle(createAccountProxyRouter(accounts, routerOptions));
  const retired = new Set();
  let closed = false;

  const closeHandle = async (handle) => {
    if (!handle) return;
    if (handle.closePromise) return handle.closePromise;
    handle.closeStarted = true;
    if (handle.timer) clearTimeout(handle.timer);
    handle.timer = null;
    retired.delete(handle);
    handle.closePromise = Promise.resolve(handle.router.close());
    await handle.closePromise;
  };

  const release = (handle) => {
    handle.leases = Math.max(0, handle.leases - 1);
    if (handle.retired && handle.closeWhenReleased && handle.leases === 0) {
      void closeHandle(handle);
    }
  };

  const responseWithLease = (response, handle) => {
    if (!(response instanceof Response) || !response.body) {
      release(handle);
      return response;
    }
    const { readable, writable } = new TransformStream();
    const pump = response.body.pipeTo(writable)
      .catch(async (error) => {
        try { await writable.abort(error); } catch {}
      })
      .finally(() => release(handle));
    void pump;
    return new Response(readable, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  const runWithHandle = (handle, operation) => {
    handle.leases += 1;
    let result;
    try {
      result = routerContext.run(handle, operation);
    } catch (error) {
      release(handle);
      throw error;
    }
    if (result && typeof result.then === 'function') {
      return result.then(
        (value) => responseWithLease(value, handle),
        (error) => {
          release(handle);
          throw error;
        },
      );
    }
    return responseWithLease(result, handle);
  };

  const routedFetch = (input, init) => {
    const handle = routerContext.getStore() || current;
    return handle.router.fetch(input, init);
  };
  globalThis.fetch = routedFetch;

  const retire = (handle) => {
    if (!handle) return;
    handle.retired = true;
    retired.add(handle);
    const closeIfIdle = () => {
      handle.timer = null;
      if (handle.leases > 0) {
        handle.closeWhenReleased = true;
      } else {
        void closeHandle(handle);
      }
    };
    if (retireMs === 0) {
      closeIfIdle();
    } else {
      handle.timer = setTimeout(closeIfIdle, retireMs);
      handle.timer.unref?.();
    }
    if (retired.size > 16) {
      for (const oldHandle of retired) {
        if (retired.size <= 16) break;
        if (oldHandle.leases === 0) {
          oldHandle.closeWhenReleased = true;
          void closeHandle(oldHandle);
        }
      }
    }
  };

  return {
    get stats() {
      return current.router.stats;
    },
    reload(nextAccounts) {
      if (closed) throw new AccountProxyRequestError('account proxy manager is closed');
      const next = makeHandle(createAccountProxyRouter(nextAccounts, routerOptions));
      const previous = current;
      current = next;
      retire(previous);
      return next.router.stats;
    },
    runWithCurrent(operation) {
      if (closed) throw new AccountProxyRequestError('account proxy manager is closed');
      if (typeof operation !== 'function') throw new TypeError('operation must be a function');
      return runWithHandle(current, operation);
    },
    async close() {
      if (closed) return;
      closed = true;
      const handles = [current, ...retired];
      for (const handle of handles) if (handle.timer) clearTimeout(handle.timer);
      retired.clear();
      await Promise.allSettled(handles.map((handle) => closeHandle(handle)));
    },
    restore() {
      if (globalThis.fetch === routedFetch) globalThis.fetch = previousFetch;
    },
  };
}
