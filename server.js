import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAccountRoute,
  loadCredentialAccounts,
  loadCredentialRecords,
  parseEnvBoolean,
  parseProtectedHosts,
  parseTokenEntries,
} from './account-proxy.js';
import {
  AccountRuntime,
  AccountService,
  AccountServiceError,
  importLegacyCredentials,
} from './account-manager.js';
import { AccountRecoveryMonitor } from './account-recovery-monitor.js';
import { AccountStore } from './account-store.js';
import { initializeAdminAuth } from './admin-auth.js';
import { createAdminHandler } from './admin-server.js';
import { createCredentialVault } from './credential-vault.js';
import { FreebuffAuthorizer } from './freebuff-authorizer.js';
import { listTestModels, testAccountModel } from './admin-model-tester.js';
import {
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  parsePositiveInteger,
  readNodeRequestBody,
  RequestBodyTooLargeError,
  requireApiKey,
  writeWebResponseToNodeResponse,
} from './server-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageMetadata = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'));

function secretValue(name) {
  const direct = process.env[name];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const file = process.env[`${name}_FILE`];
  if (!file) return '';
  return readFileSync(resolve(file), 'utf8').trim();
}

function parsePort(value, defaultValue, name) {
  const port = parsePositiveInteger(value, defaultValue, name);
  if (port > 65535) throw new Error(`${name} must be between 1 and 65535`);
  return port;
}

function environmentAccounts(requireAccountProxy) {
  const accounts = [];
  const proxyUrl = process.env.FREEBUFF_PROXY_URL || '';
  for (const entry of parseTokenEntries(process.env.FREEBUFF_TOKEN)) {
    if (!proxyUrl && requireAccountProxy) {
      throw new Error('FREEBUFF_TOKEN requires FREEBUFF_PROXY_URL when REQUIRE_ACCOUNT_PROXY=true');
    }
    accounts.push(createAccountRoute({
      token: entry.token,
      tokenEntry: entry.tokenEntry,
      source: 'FREEBUFF_TOKEN',
      proxyUrl: proxyUrl || undefined,
      proxyRequired: requireAccountProxy,
    }));
  }
  return accounts;
}

const publicHost = process.env.HOST || '0.0.0.0';
const publicPort = parsePort(process.env.PORT, 8787, 'PORT');
const adminEnabled = parseEnvBoolean(process.env.ADMIN_ENABLED, false, 'ADMIN_ENABLED');
const configuredApiKeyValue = secretValue('FREEBUFF_API_KEY');
let apiKey = null;
if (!adminEnabled) apiKey = requireApiKey(configuredApiKeyValue);
const maxRequestBodyBytes = parsePositiveInteger(
  process.env.MAX_REQUEST_BODY_BYTES,
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  'MAX_REQUEST_BODY_BYTES',
);
const requireAccountProxy = parseEnvBoolean(
  process.env.REQUIRE_ACCOUNT_PROXY,
  false,
  'REQUIRE_ACCOUNT_PROXY',
);
const accountProxyConnectTimeoutMs = parsePositiveInteger(
  process.env.ACCOUNT_PROXY_CONNECT_TIMEOUT_MS,
  10000,
  'ACCOUNT_PROXY_CONNECT_TIMEOUT_MS',
);
const accountProxyRetireMs = parsePositiveInteger(
  process.env.ACCOUNT_PROXY_RETIRE_MS,
  300000,
  'ACCOUNT_PROXY_RETIRE_MS',
);
const protectedHosts = parseProtectedHosts(process.env.ACCOUNT_PROXY_TARGET_HOSTS);
const credentialDirectory = resolve(process.env.CREDENTIALS_DIR || resolve(__dirname, 'credentials'));
if (adminEnabled && String(process.env.FREEBUFF_TOKEN || '').trim()) {
  throw new Error('FREEBUFF_TOKEN cannot be used when ADMIN_ENABLED=true; import the account into SQLite instead');
}
const envAccounts = adminEnabled ? [] : environmentAccounts(requireAccountProxy);
const adminHost = process.env.ADMIN_HOST || '127.0.0.1';
const adminPort = parsePort(process.env.ADMIN_PORT, 8788, 'ADMIN_PORT');
const adminMaxBodyBytes = parsePositiveInteger(
  process.env.ADMIN_MAX_REQUEST_BODY_BYTES,
  256 * 1024,
  'ADMIN_MAX_REQUEST_BODY_BYTES',
);
const adminTrustProxy = parseEnvBoolean(
  process.env.ADMIN_TRUST_PROXY,
  false,
  'ADMIN_TRUST_PROXY',
);

let accountStore = null;
let accountService = null;
let adminAuth = null;
let freebuffAuthorizer = null;
let accountRecoveryMonitor = null;

if (adminEnabled) {
  const vault = createCredentialVault(secretValue('ACCOUNT_STORE_KEY'));
  accountStore = new AccountStore({
    databasePath: resolve(process.env.ACCOUNT_DB_PATH || resolve(__dirname, 'data', 'freebuff.sqlite')),
    vault,
  });
  const storedApiKey = accountStore.getSecretSetting('api_key_cipher', 'settings:api_key');
  if (storedApiKey) {
    apiKey = requireApiKey(storedApiKey);
  } else {
    apiKey = requireApiKey(configuredApiKeyValue);
    accountStore.transaction(() => {
      accountStore.setSecretSetting('api_key_cipher', apiKey, 'settings:api_key');
      accountStore.setSetting('api_key_updated_at', new Date().toISOString());
    });
  }
  const shouldReadLegacyCredentials = accountStore.getSetting('legacy_import_completed') !== 'true'
    && accountStore.countAccounts() === 0;
  const legacyRecords = shouldReadLegacyCredentials
    ? loadCredentialRecords(credentialDirectory)
    : [];
  const imported = importLegacyCredentials(accountStore, legacyRecords, {
    requireProxy: requireAccountProxy,
  });
  if (imported.imported > 0) {
    console.log(`[admin] imported ${imported.imported} legacy accounts (${imported.disabled} disabled)`);
  }
  adminAuth = await initializeAdminAuth({
    store: accountStore,
    initialUsername: process.env.ADMIN_USERNAME || 'admin',
    initialPassword: secretValue('ADMIN_PASSWORD'),
    sessionTtlSeconds: parsePositiveInteger(
      process.env.ADMIN_SESSION_TTL_SECONDS,
      12 * 60 * 60,
      'ADMIN_SESSION_TTL_SECONDS',
    ),
    secureCookies: parseEnvBoolean(
      process.env.ADMIN_COOKIE_SECURE,
      false,
      'ADMIN_COOKIE_SECURE',
    ),
  });
}

const runtime = new AccountRuntime({
  store: accountStore,
  staticAccounts: adminEnabled ? [] : loadCredentialAccounts(credentialDirectory),
  environmentAccounts: adminEnabled ? [] : envAccounts,
  requireProxy: requireAccountProxy,
  protectedHosts,
  connectTimeoutMs: accountProxyConnectTimeoutMs,
  retireMs: accountProxyRetireMs,
});
runtime.initialize();

if (accountStore) {
  accountService = new AccountService({
    store: accountStore,
    runtime,
    requireProxy: requireAccountProxy,
    connectTimeoutMs: accountProxyConnectTimeoutMs,
    modelTester: (account, model, options = {}) => testAccountModel(account, model, {
      ...options,
      upstreamBaseUrl: process.env.CODEBUFF_API || undefined,
    }),
    modelCatalog: listTestModels,
    upstreamBaseUrl: process.env.CODEBUFF_API || undefined,
  });
  freebuffAuthorizer = new FreebuffAuthorizer({ accountService });
}

// Install the stable, reloadable Node fetch router before importing the Worker.
const worker = await import('./worker.js');
const workerHandler = worker.default;

const workerEnv = {
  FREEBUFF_DEBUG: process.env.FREEBUFF_DEBUG || 'false',
  CODEBUFF_API: process.env.CODEBUFF_API || '',
  RELAY_KEY: process.env.RELAY_KEY || '',
};
function workerEnvironment(snapshot) {
  return {
    ...workerEnv,
    FREEBUFF_API_KEY: apiKey,
    FREEBUFF_TOKEN: snapshot.tokenString,
    FREEBUFF_ACCOUNT_GENERATION: String(snapshot.generation),
  };
}
runtime.setAccountStateInvalidator((tokens, activeTokenString, activeGeneration) => {
  workerHandler.invalidateAccountState?.(tokens, activeTokenString, activeGeneration);
});
if (accountService) {
  worker.setAccountObservationSink?.((event) => {
    void accountService.observeRateLimit(event).catch((error) => {
      console.error('[recovery] could not persist rate-limit pause:', error?.message || 'unknown error');
    });
  });
  accountRecoveryMonitor = new AccountRecoveryMonitor({
    accountService,
    onError: (error) => console.error('[recovery] scheduled probe failed:', error?.message || 'unknown error'),
  });
  accountRecoveryMonitor.start();
}

const stats = runtime.snapshot.stats;
console.log(`[server] start: ${runtime.snapshot.tokenLines.length} accounts, apiKey=set, debug=${workerEnv.FREEBUFF_DEBUG}`);
console.log(`[server] proxy routes: proxied=${stats.proxiedAccounts}, direct=${stats.directAccounts}, required=${stats.requireProxy}, http=${stats.proxyKinds.http}, https=${stats.proxyKinds.https}, socks5=${stats.proxyKinds.socks5}`);
if (workerEnv.CODEBUFF_API) console.log('[server] CODEBUFF_API set');
if (workerEnv.RELAY_KEY) console.log('[server] RELAY_KEY set');

async function workerHealth() {
  return runtime.runWithCurrentProxySnapshot(async (snapshot) => {
    const response = await workerHandler.fetch(
      new Request('http://local.internal/healthz', {
        headers: { authorization: `Bearer ${apiKey}` },
      }),
      workerEnvironment(snapshot),
    );
    if (!response.ok) return {};
    const payload = await response.json();
    if (Array.isArray(payload.account_details)) {
      payload.account_details = payload.account_details.map((detail, index) => ({
        ...detail,
        accountId: snapshot.managedAccountIds[index] || null,
        accountGeneration: snapshot.generation,
      }));
    }
    return payload;
  });
}

function maskApiKey(value) {
  const text = String(value || '');
  if (!text) return null;
  if (text.length <= 8) return '*'.repeat(text.length);
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function apiKeyInfo() {
  return {
    configured: Boolean(apiKey),
    masked: maskApiKey(apiKey),
    updatedAt: accountStore?.getSetting('api_key_updated_at') || null,
  };
}

function rotateApiKey(body, actor = 'admin') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AccountServiceError('API key configuration must be an object', 400, 'ADMIN_API_KEY_INVALID');
  }
  const generated = body.generate === true;
  const raw = generated ? randomBytes(32).toString('base64url') : body.apiKey;
  if (!generated && typeof raw !== 'string') {
    throw new AccountServiceError('apiKey is required unless generate is true', 400, 'ADMIN_API_KEY_INVALID');
  }
  let next;
  try {
    next = requireApiKey(String(raw || '').trim());
  } catch {
    throw new AccountServiceError('API key must be a non-default value', 400, 'ADMIN_API_KEY_INVALID');
  }
  if (next.length < 20 || next.length > 256) {
    throw new AccountServiceError('API key must be 20-256 characters', 400, 'ADMIN_API_KEY_INVALID');
  }
  const updatedAt = new Date().toISOString();
  accountStore.transaction(() => {
    accountStore.setSecretSetting('api_key_cipher', next, 'settings:api_key');
    accountStore.setSetting('api_key_updated_at', updatedAt);
    accountStore.appendAudit({
      actor,
      action: 'api_key.rotated',
      summary: `Rotated API key (${generated ? 'generated' : 'provided'})`,
    });
  });
  apiKey = next;
  return { apiKey: next, info: apiKeyInfo() };
}

let adminHandler = null;
if (adminEnabled) {
  adminHandler = createAdminHandler({
    auth: adminAuth,
    accountService,
    uiDirectory: resolve(__dirname, 'admin-ui'),
    getAccountHealth: async () => (await workerHealth()).account_details || [],
    getApiKeyInfo: apiKeyInfo,
    rotateApiKey,
    authorizer: freebuffAuthorizer,
    getSystemInfo: async () => {
      const health = await workerHealth();
      const current = runtime.snapshot.stats;
      return {
        appVersion: packageMetadata.version,
        workerVersion: health.version || 'unknown',
        requireProxy: requireAccountProxy,
        accountCount: accountStore.countAccounts(),
        enabledAccountCount: runtime.snapshot.managedAccountIds.length,
        autoPausedAccountCount: accountStore.listAccounts().filter((account) => account.autoPaused).length,
        proxyKinds: current.proxyKinds,
      };
    },
    onError: (error) => console.error('[admin] request error:', error?.message || 'unknown error'),
  });
}

function requestUrl(nodeRequest, host) {
  return `http://${nodeRequest.headers.host || host}${nodeRequest.url || '/'}`;
}

function requestRemoteAddress(nodeRequest, trustProxy) {
  const directAddress = nodeRequest.socket.remoteAddress || 'unknown';
  if (!trustProxy) return directAddress;
  const forwarded = Array.isArray(nodeRequest.headers['x-forwarded-for'])
    ? nodeRequest.headers['x-forwarded-for'][0]
    : nodeRequest.headers['x-forwarded-for'];
  const candidate = String(forwarded || '').split(',', 1)[0].trim();
  return isIP(candidate) ? candidate : directAddress;
}

function createNodeBridge(webHandler, {
  maxBodyBytes,
  label,
  errorStatus,
  trustProxy = false,
}) {
  return async (nodeRequest, nodeResponse) => {
    try {
      let body;
      try {
        body = await readNodeRequestBody(nodeRequest, maxBodyBytes);
      } catch (error) {
        if (!(error instanceof RequestBodyTooLargeError)) throw error;
        nodeResponse.writeHead(413, {
          connection: 'close',
          'content-type': 'application/json',
        });
        nodeResponse.end(JSON.stringify({
          error: { message: 'request body too large', type: 'request_too_large' },
        }), () => nodeRequest.destroy());
        return;
      }

      const request = new Request(requestUrl(nodeRequest, label), {
        method: nodeRequest.method,
        headers: new Headers(nodeRequest.headers),
        body: body.length > 0 ? body : null,
      });
      const response = await webHandler(request, {
        remoteAddress: requestRemoteAddress(nodeRequest, trustProxy),
      });
      await writeWebResponseToNodeResponse(response, nodeResponse);
    } catch (error) {
      console.error(`[${label}] request error:`, error?.message || 'unknown error');
      if (!nodeResponse.headersSent) {
        nodeResponse.writeHead(errorStatus, { 'content-type': 'application/json' });
        nodeResponse.end(JSON.stringify({
          error: {
            message: label === 'server' ? 'proxy error' : 'admin service error',
            type: label === 'server' ? 'proxy_error' : 'admin_error',
          },
        }));
      } else if (!nodeResponse.writableEnded) {
        nodeResponse.end();
      }
    }
  };
}

const publicServer = createServer(createNodeBridge(
  (request) => runtime.runWithCurrentProxySnapshot((snapshot) => workerHandler.fetch(request, workerEnvironment(snapshot))),
  { maxBodyBytes: maxRequestBodyBytes, label: 'server', errorStatus: 502 },
));
const adminServer = adminHandler
  ? createServer(createNodeBridge(adminHandler, {
    maxBodyBytes: adminMaxBodyBytes,
    label: 'admin',
    errorStatus: 500,
    trustProxy: adminTrustProxy,
  }))
  : null;

function listen(server, port, host, name) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      console.log(`[${name}] listening on ${host}:${port}`);
      resolvePromise();
    });
  });
}

await listen(publicServer, publicPort, publicHost, 'server');
if (adminServer) await listen(adminServer, adminPort, adminHost, 'admin');

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);
  const forceExit = setTimeout(() => process.exit(1), 10000);
  forceExit.unref();
  await Promise.allSettled([closeServer(publicServer), closeServer(adminServer)]);
  await Promise.allSettled([
    freebuffAuthorizer?.cancelAll?.(),
    accountRecoveryMonitor?.stop?.(),
  ]);
  await runtime.close();
  accountStore?.close();
  clearTimeout(forceExit);
  process.exitCode = 0;
}

process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
