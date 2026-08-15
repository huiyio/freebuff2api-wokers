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

function sanitizedProxyError(error) {
  const errorNames = new Set([error?.name, error?.cause?.name]);
  if (errorNames.has('AbortError')) {
    const safe = new AccountProxyRequestError('account proxy request aborted', 'ABORT_ERR');
    safe.name = 'AbortError';
    return safe;
  }
  const rawCode = error?.code || error?.cause?.code;
  if (
    errorNames.has('TimeoutError')
    || errorNames.has('ConnectTimeoutError')
    || TIMEOUT_NETWORK_CODES.has(rawCode)
  ) {
    const safe = new AccountProxyRequestError('account proxy request timed out', 'ETIMEDOUT');
    safe.name = 'TimeoutError';
    return safe;
  }

  const code = SAFE_NETWORK_CODES.has(rawCode) ? rawCode : 'ACCOUNT_PROXY_ERROR';
  return new AccountProxyRequestError(`account proxy request failed (${code})`, code);
}

export async function probeAccountProxy(account, options = {}) {
  if (!account?.proxy) {
    throw new AccountProxyRequestError('account proxy route is unavailable', 'ACCOUNT_PROXY_REQUIRED');
  }
  const connectTimeoutMs = options.connectTimeoutMs ?? 10000;
  const testUrl = options.testUrl || 'https://www.codebuff.com/';
  const fetchImpl = options.fetchImpl || undiciFetch;
  const created = createDispatcher(account.proxy, connectTimeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(testUrl, {
      method: 'HEAD',
      redirect: 'manual',
      dispatcher: created.dispatcher,
      signal: AbortSignal.timeout(connectTimeoutMs),
    });
    try { await response.body?.cancel(); } catch {}
    return {
      ok: true,
      httpStatus: response.status,
      latencyMs: Date.now() - startedAt,
      message: 'proxy reached the fixed upstream target',
    };
  } catch (error) {
    const safe = sanitizedProxyError(error);
    return {
      ok: false,
      code: safe.code,
      latencyMs: Date.now() - startedAt,
      message: safe.message,
    };
  } finally {
    try { await created.dispatcher.close?.(); } catch {}
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
        throw sanitizedProxyError(error);
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
