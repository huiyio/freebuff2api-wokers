import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AccountRuntime, AccountService } from '../account-manager.js';
import { AccountStore } from '../account-store.js';
import { initializeAdminAuth } from '../admin-auth.js';
import { createAdminHandler } from '../admin-server.js';
import { createCredentialVault } from '../credential-vault.js';

function unusedPort() {
  const server = createHttpServer();
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolvePromise(port));
    });
  });
}

function waitForOutput(child, expected, timeoutMs = 15000) {
  return new Promise((resolvePromise, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error(`timed out waiting for ${expected}\n${output}`)), timeoutMs);
    const onData = (chunk) => {
      output += chunk;
      if (output.includes(expected)) finish();
    };
    const onExit = (code, signal) => {
      finish(new Error(`server exited before startup (${code ?? signal})\n${output}`));
    };
    const finish = (error) => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolvePromise(output);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
  });
}

function postJson(port, path, body, extraHeaders = {}) {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...extraHeaders,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => resolvePromise({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

function requestJsonMethod(port, path, method, body, extraHeaders = {}) {
  return new Promise((resolvePromise, reject) => {
    const payload = body === undefined ? '' : body;
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(body === undefined ? {} : {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        }),
        ...extraHeaders,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => resolvePromise({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise));
  child.kill('SIGTERM');
  let timer;
  await Promise.race([
    exited,
    new Promise((resolvePromise) => {
      timer = setTimeout(resolvePromise, 3000);
    }),
  ]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

test('serves a hardened admin UI and keeps credentials out of CRUD responses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freebuff-admin-server-'));
  const store = new AccountStore({
    databasePath: join(directory, 'admin.sqlite'),
    vault: createCredentialVault('71'.repeat(32)),
  });
  const runtime = new AccountRuntime({ store, requireProxy: true, retireMs: 0 });
  runtime.initialize();
  const service = new AccountService({ store, runtime, requireProxy: true });
  const authorizationCalls = [];
  const authorizer = {
    async start(session) {
      authorizationCalls.push({ action: 'start', session });
      return {
        authorization: {
          id: 'authorization-1',
          status: 'pending',
          createdAt: '2026-08-16T00:00:00.000Z',
          loginUrl: 'https://www.codebuff.com/login?auth_code=one-time-code',
        },
      };
    },
    async poll(id, session) {
      authorizationCalls.push({ action: 'poll', id, session });
      return {
        authorization: {
          id,
          status: 'completed',
          createdAt: '2026-08-16T00:00:00.000Z',
          account: { id: 'authorized-account', name: 'authorized@example.com', enabled: false },
        },
      };
    },
    async cancel(id, session) {
      authorizationCalls.push({ action: 'cancel', id, session });
      return { authorization: { id, status: 'cancelled', createdAt: '2026-08-16T00:00:00.000Z' } };
    },
    async cancelBySession(session) {
      authorizationCalls.push({ action: 'cancel-session', session });
      return { cancelled: 1 };
    },
    async cancelAll() {
      authorizationCalls.push({ action: 'cancel-all' });
      return { cancelled: 1 };
    },
  };
  const auth = await initializeAdminAuth({
    store,
    initialPassword: 'integration-admin-password',
    sessionTtlSeconds: 3600,
    maxLoginAttempts: 2,
    loginWindowSeconds: 60,
  });
  const uiDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'admin-ui');
  const handler = createAdminHandler({
    auth,
    accountService: service,
    uiDirectory,
    getAccountHealth: async () => [{ account: 1, alive: true, state: 'active' }],
    getSystemInfo: async () => ({ appVersion: 'test-version', requireProxy: true }),
    authorizer,
  });

  try {
    const page = await handler(new Request('http://local/admin/'));
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const pageText = await page.text();
    assert.match(pageText, /Freebuff Control/);
    assert.match(pageText, /login-username/);
    assert.match(pageText, /api-key-confirm-dialog/);
    assert.match(pageText, /account-authorization-dialog/);
    assert.match(pageText, /authorize-account-button/);
    assert.match(pageText, /rel="noopener noreferrer"/);
    assert.match(pageText, /integration-docs/);
    assert.match(pageText, /integration-base-url/);
    assert.match(pageText, /\/v1\/chat\/completions/);
    assert.match(pageText, /\/v1\/responses/);
    assert.match(pageText, /\/v1\/messages\/count_tokens/);
    assert.match(pageText, /integration-tab-anthropic/);

    const appAsset = await handler(new Request('http://local/admin/app.js'));
    assert.equal(appAsset.status, 200);
    const appText = await appAsset.text();
    assert.match(appText, /publicPortByAdminPort/);
    assert.match(appText, /mimo\/mimo-v2\.5/);
    assert.match(appText, /Authorization: Bearer YOUR_API_KEY/);
    assert.match(appText, /from anthropic import Anthropic/);
    assert.match(appText, /account-authorizations/);

    const stylesAsset = await handler(new Request('http://local/admin/styles.css'));
    assert.equal(stylesAsset.status, 200);
    assert.match(await stylesAsset.text(), /\.integration-docs/);

    const denied = await handler(new Request('http://local/admin/api/accounts'));
    assert.equal(denied.status, 401);

    const login = await handler(new Request('http://local/admin/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'integration-admin-password' }),
    }), { remoteAddress: '127.0.0.1' });
    const loginPayload = await login.json();
    assert.equal(loginPayload.username, 'admin');
    const cookieHeader = login.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
    const mutationHeaders = {
      'content-type': 'application/json',
      cookie: cookieHeader,
      'x-csrf-token': loginPayload.csrfToken,
    };

    const sessionResponse = await handler(new Request('http://local/admin/api/session', {
      headers: { cookie: cookieHeader },
    }));
    assert.equal(sessionResponse.status, 200);
    assert.equal((await sessionResponse.json()).username, 'admin');

    const noCsrf = await handler(new Request('http://local/admin/api/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader },
      body: '{}',
    }));
    assert.equal(noCsrf.status, 403);
    assert.equal((await noCsrf.json()).error.type, 'ADMIN_CSRF_INVALID');

    const startedAuthorization = await handler(new Request('http://local/admin/api/account-authorizations', {
      method: 'POST',
      headers: mutationHeaders,
      body: '{}',
    }));
    assert.equal(startedAuthorization.status, 201);
    assert.equal((await startedAuthorization.json()).authorization.loginUrl, 'https://www.codebuff.com/login?auth_code=one-time-code');
    assert.equal(authorizationCalls[0].action, 'start');
    assert.equal(authorizationCalls[0].session.username, 'admin');

    const polledAuthorization = await handler(new Request('http://local/admin/api/account-authorizations/authorization-1', {
      method: 'POST',
      headers: mutationHeaders,
      body: '{}',
    }));
    assert.equal(polledAuthorization.status, 200);
    assert.equal((await polledAuthorization.json()).authorization.status, 'completed');
    assert.equal(authorizationCalls[1].action, 'poll');

    const cancelledAuthorization = await handler(new Request('http://local/admin/api/account-authorizations/authorization-1', {
      method: 'DELETE',
      headers: mutationHeaders,
      body: '{}',
    }));
    assert.equal(cancelledAuthorization.status, 200);
    assert.equal((await cancelledAuthorization.json()).authorization.status, 'cancelled');
    assert.equal(authorizationCalls[2].action, 'cancel');

    const created = await handler(new Request('http://local/admin/api/accounts', {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({
        name: 'Web Account',
        email: 'web@example.com',
        authToken: 'web-account-token-12345',
        proxyUrl: 'socks5://user:password@proxy.example.com:1080',
        proxyRequired: true,
        enabled: true,
      }),
    }));
    assert.equal(created.status, 201);

    const listed = await handler(new Request('http://local/admin/api/accounts', {
      headers: { cookie: cookieHeader },
    }));
    const listedText = await listed.text();
    assert.doesNotMatch(listedText, /web-account-token|password/);
    const listedPayload = JSON.parse(listedText);
    assert.equal(listedPayload.accounts[0].upstreamState, 'active');

    const system = await handler(new Request('http://local/admin/api/system', {
      headers: { cookie: cookieHeader },
    }));
    assert.equal((await system.json()).system.appVersion, 'test-version');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failedLogin = await handler(new Request('http://local/admin/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'incorrect-test-password' }),
      }), { remoteAddress: '198.51.100.10' });
      assert.equal(failedLogin.status, 401);
    }
    const limitedLogin = await handler(new Request('http://local/admin/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'integration-admin-password' }),
    }), { remoteAddress: '198.51.100.10' });
    assert.equal(limitedLogin.status, 429);
    assert.match(limitedLogin.headers.get('retry-after'), /^\d+$/);
    assert.equal((await limitedLogin.json()).error.type, 'ADMIN_LOGIN_RATE_LIMITED');

    const changedPassword = await handler(new Request('http://local/admin/api/password', {
      method: 'PUT',
      headers: mutationHeaders,
      body: JSON.stringify({
        currentPassword: 'integration-admin-password',
        nextPassword: 'integration-admin-password-next',
      }),
    }));
    assert.equal(changedPassword.status, 200);
    assert.equal(authorizationCalls.at(-1).action, 'cancel-all');

    const relogin = await handler(new Request('http://local/admin/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'integration-admin-password-next' }),
    }), { remoteAddress: '127.0.0.2' });
    const reloginPayload = await relogin.json();
    const reloginCookie = relogin.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
    const loggedOut = await handler(new Request('http://local/admin/api/logout', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: reloginCookie,
        'x-csrf-token': reloginPayload.csrfToken,
      },
      body: '{}',
    }));
    assert.equal(loggedOut.status, 200);
    assert.equal(authorizationCalls.at(-1).action, 'cancel-session');
  } finally {
    await runtime.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('protects API key settings with auth and CSRF without leaking the stored value', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freebuff-admin-api-key-'));
  const store = new AccountStore({
    databasePath: join(directory, 'admin.sqlite'),
    vault: createCredentialVault('72'.repeat(32)),
  });
  const runtime = new AccountRuntime({ store, requireProxy: false, retireMs: 0 });
  runtime.initialize();
  const service = new AccountService({ store, runtime, requireProxy: false });
  const auth = await initializeAdminAuth({
    store,
    initialPassword: 'api-key-admin-password',
    sessionTtlSeconds: 3600,
  });
  const uiDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'admin-ui');
  const storedKey = 'stored-api-key-value-that-is-not-public';
  let rotated = null;
  const handler = createAdminHandler({
    auth,
    accountService: service,
    uiDirectory,
    getApiKeyInfo: () => ({
      configured: true,
      masked: 'stor...blic',
      updatedAt: '2026-08-15T00:00:00.000Z',
    }),
    rotateApiKey: (body, actor) => {
      rotated = { body, actor };
      return {
        apiKey: storedKey,
        info: { configured: true, masked: 'stor...blic', updatedAt: '2026-08-15T00:00:00.000Z' },
      };
    },
  });

  try {
    const denied = await handler(new Request('http://local/admin/api/api-key'));
    assert.equal(denied.status, 401);

    const login = await handler(new Request('http://local/admin/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'api-key-admin-password' }),
    }), { remoteAddress: '127.0.0.1' });
    const loginPayload = await login.json();
    const cookieHeader = login.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');

    const current = await handler(new Request('http://local/admin/api/api-key', {
      headers: { cookie: cookieHeader },
    }));
    assert.equal(current.status, 200);
    const currentText = await current.text();
    assert.doesNotMatch(currentText, /stored-api-key-value-that-is-not-public/);
    assert.match(currentText, /stor\.\.\.blic/);

    const noCsrf = await handler(new Request('http://local/admin/api/api-key', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: cookieHeader },
      body: JSON.stringify({ apiKey: 'next-api-key-value-that-is-long-enough' }),
    }));
    assert.equal(noCsrf.status, 403);

    const updated = await handler(new Request('http://local/admin/api/api-key', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader,
        'x-csrf-token': loginPayload.csrfToken,
      },
      body: JSON.stringify({ generate: true }),
    }));
    assert.equal(updated.status, 200);
    assert.deepEqual(rotated, { body: { generate: true }, actor: 'admin' });
    const updatedPayload = await updated.json();
    assert.equal(updatedPayload.apiKey.apiKey, storedKey);
    assert.equal(updatedPayload.apiKey.info.masked, 'stor...blic');
  } finally {
    await runtime.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('protects the API key route, returns only a mask on GET, and does not audit the secret', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freebuff-admin-api-key-route-'));
  const store = new AccountStore({
    databasePath: join(directory, 'admin.sqlite'),
    vault: createCredentialVault('72'.repeat(32)),
  });
  const auth = await initializeAdminAuth({
    store,
    initialPassword: 'api-key-route-admin-password',
    sessionTtlSeconds: 3600,
  });
  const uiDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'admin-ui');
  let currentKey = 'initial-api-key-route-123456789';
  let rotateActor = null;
  const mask = (value) => `${value.slice(0, 4)}...${value.slice(-4)}`;
  const getApiKeyInfo = () => ({
    configured: true,
    masked: mask(currentKey),
    updatedAt: '2026-08-15T00:00:00.000Z',
  });
  const handler = createAdminHandler({
    auth,
    accountService: { store },
    uiDirectory,
    getApiKeyInfo,
    rotateApiKey: async (body, actor) => {
      rotateActor = actor;
      currentKey = body.apiKey;
      store.appendAudit({
        actor,
        action: 'api_key.rotated',
        summary: 'Rotated API key (provided)',
      });
      return { apiKey: currentKey, info: getApiKeyInfo() };
    },
  });

  try {
    const denied = await handler(new Request('http://local/admin/api/api-key'));
    assert.equal(denied.status, 401);

    const login = await handler(new Request('http://local/admin/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'api-key-route-admin-password' }),
    }), { remoteAddress: '127.0.0.1' });
    assert.equal(login.status, 200);
    const loginPayload = await login.json();
    const cookieHeader = login.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
    const headers = {
      'content-type': 'application/json',
      cookie: cookieHeader,
      'x-csrf-token': loginPayload.csrfToken,
    };

    const masked = await handler(new Request('http://local/admin/api/api-key', {
      headers: { cookie: cookieHeader },
    }));
    assert.equal(masked.status, 200);
    const maskedText = await masked.text();
    assert.doesNotMatch(maskedText, /initial-api-key-route-123456789/);
    assert.equal(JSON.parse(maskedText).apiKey.masked, mask(currentKey));

    const noCsrf = await handler(new Request('http://local/admin/api/api-key', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: cookieHeader },
      body: JSON.stringify({ apiKey: 'rotated-api-key-route-123456789' }),
    }));
    assert.equal(noCsrf.status, 403);
    assert.equal((await noCsrf.json()).error.type, 'ADMIN_CSRF_INVALID');

    const nextKey = 'rotated-api-key-route-123456789';
    const rotated = await handler(new Request('http://local/admin/api/api-key', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ apiKey: nextKey }),
    }));
    assert.equal(rotated.status, 200);
    const rotatedPayload = await rotated.json();
    assert.equal(rotatedPayload.apiKey.apiKey, nextKey);
    assert.equal(rotatedPayload.apiKey.info.masked, mask(nextKey));
    assert.equal(rotateActor, 'admin');

    const afterRotation = await handler(new Request('http://local/admin/api/api-key', {
      headers: { cookie: cookieHeader },
    }));
    const afterRotationText = await afterRotation.text();
    assert.doesNotMatch(afterRotationText, /rotated-api-key-route-123456789/);

    const audit = await handler(new Request('http://local/admin/api/audit', {
      headers: { cookie: cookieHeader },
    }));
    const auditText = await audit.text();
    assert.doesNotMatch(auditText, /initial-api-key-route|rotated-api-key-route/);
    assert.match(auditText, /api_key\.rotated/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('rotates the live API key, rejects unsafe values, and restores it after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freebuff-admin-api-key-process-'));
  const credentialsDirectory = join(directory, 'credentials');
  await mkdir(credentialsDirectory);
  const projectDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
  const databasePath = join(directory, 'accounts.sqlite');
  const originalKey = 'original-process-api-key-123456789';
  const rotatedKey = 'rotated-process-api-key-987654321';
  const adminPassword = 'api-key-process-admin-password';
  const baseEnv = {
    ...process.env,
    HOST: '127.0.0.1',
    FREEBUFF_API_KEY: originalKey,
    FREEBUFF_TOKEN: '',
    FREEBUFF_PROXY_URL: '',
    CODEBUFF_API: '',
    RELAY_KEY: '',
    CREDENTIALS_DIR: credentialsDirectory,
    REQUIRE_ACCOUNT_PROXY: 'false',
      ADMIN_ENABLED: 'true',
      ADMIN_HOST: '127.0.0.1',
      ADMIN_USERNAME: 'process-admin',
      ADMIN_PASSWORD: adminPassword,
    ADMIN_COOKIE_SECURE: 'false',
    ACCOUNT_STORE_KEY: '82'.repeat(32),
    ACCOUNT_DB_PATH: databasePath,
    ACCOUNT_PROXY_RETIRE_MS: '1',
  };
  let child;

  try {
    const publicPort = await unusedPort();
    const adminPort = await unusedPort();
    child = spawn(process.execPath, ['server.js'], {
      cwd: projectDirectory,
      windowsHide: true,
      env: { ...baseEnv, PORT: String(publicPort), ADMIN_PORT: String(adminPort) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForOutput(child, `[admin] listening on 127.0.0.1:${adminPort}`);

    const initialPublic = await postJson(
      publicPort,
      '/v1/messages/count_tokens',
      JSON.stringify({ model: 'mimo/mimo-v2.5', messages: [{ role: 'user', content: 'ping' }] }),
      { authorization: `Bearer ${originalKey}` },
    );
    assert.equal(initialPublic.status, 200);

    const login = await postJson(
      adminPort,
      '/admin/api/login',
      JSON.stringify({ username: 'process-admin', password: adminPassword }),
    );
    assert.equal(login.status, 200);
    const loginPayload = JSON.parse(login.body);
    assert.equal(loginPayload.username, 'process-admin');
    const setCookies = login.headers['set-cookie'] || [];
    const cookieHeader = setCookies.map((value) => value.split(';', 1)[0]).join('; ');
    const mutationHeaders = {
      cookie: cookieHeader,
      'x-csrf-token': loginPayload.csrfToken,
    };

    const keyInfo = await requestJsonMethod(adminPort, '/admin/api/api-key', 'GET', undefined, {
      cookie: cookieHeader,
    });
    assert.equal(keyInfo.status, 200);
    assert.doesNotMatch(keyInfo.body, /original-process-api-key-123456789/);
    assert.match(keyInfo.body, /orig\.\.\.[0-9]{4}/);

    const noCsrf = await requestJsonMethod(
      adminPort,
      '/admin/api/api-key',
      'PUT',
      JSON.stringify({ apiKey: rotatedKey }),
      { cookie: cookieHeader },
    );
    assert.equal(noCsrf.status, 403);
    assert.equal(JSON.parse(noCsrf.body).error.type, 'ADMIN_CSRF_INVALID');

    for (const invalidKey of [
      'freebuff-default-key',
      'too-short',
      'x'.repeat(257),
    ]) {
      const invalid = await requestJsonMethod(
        adminPort,
        '/admin/api/api-key',
        'PUT',
        JSON.stringify({ apiKey: invalidKey }),
        { ...mutationHeaders, 'content-type': 'application/json' },
      );
      assert.equal(invalid.status, 400);
      assert.equal(JSON.parse(invalid.body).error.type, 'ADMIN_API_KEY_INVALID');
    }

    const rotated = await requestJsonMethod(
      adminPort,
      '/admin/api/api-key',
      'PUT',
      JSON.stringify({ apiKey: rotatedKey }),
      { ...mutationHeaders, 'content-type': 'application/json' },
    );
    assert.equal(rotated.status, 200);
    const rotatedPayload = JSON.parse(rotated.body);
    assert.equal(rotatedPayload.apiKey.apiKey, rotatedKey);
    assert.equal(rotatedPayload.apiKey.info.masked, `rota...${rotatedKey.slice(-4)}`);
    assert.doesNotMatch(rotated.body, /original-process-api-key-123456789/);

    const oldPublic = await postJson(
      publicPort,
      '/v1/messages/count_tokens',
      JSON.stringify({ model: 'mimo/mimo-v2.5', messages: [{ role: 'user', content: 'ping' }] }),
      { authorization: `Bearer ${originalKey}` },
    );
    assert.equal(oldPublic.status, 401);
    const newPublic = await postJson(
      publicPort,
      '/v1/messages/count_tokens',
      JSON.stringify({ model: 'mimo/mimo-v2.5', messages: [{ role: 'user', content: 'ping' }] }),
      { authorization: `Bearer ${rotatedKey}` },
    );
    assert.equal(newPublic.status, 200);

    const audit = await requestJsonMethod(adminPort, '/admin/api/audit', 'GET', undefined, {
      cookie: cookieHeader,
    });
    assert.equal(audit.status, 200);
    assert.doesNotMatch(audit.body, /original-process-api-key|rotated-process-api-key/);
    assert.match(audit.body, /api_key\.rotated/);

    await stopChild(child);
    child = null;
    const persistedFiles = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    const persistedRaw = Buffer.concat(await Promise.all(
      persistedFiles.map(async (file) => readFile(join(directory, file))),
    )).toString('latin1');
    assert.doesNotMatch(persistedRaw, /original-process-api-key|rotated-process-api-key/);

    const restartedPublicPort = await unusedPort();
    const restartedAdminPort = await unusedPort();
    child = spawn(process.execPath, ['server.js'], {
      cwd: projectDirectory,
      windowsHide: true,
      env: {
        ...baseEnv,
        PORT: String(restartedPublicPort),
        ADMIN_PORT: String(restartedAdminPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForOutput(child, `[admin] listening on 127.0.0.1:${restartedAdminPort}`);

    const oldAfterRestart = await postJson(
      restartedPublicPort,
      '/v1/messages/count_tokens',
      JSON.stringify({ model: 'mimo/mimo-v2.5', messages: [{ role: 'user', content: 'ping' }] }),
      { authorization: `Bearer ${originalKey}` },
    );
    assert.equal(oldAfterRestart.status, 401);
    const newAfterRestart = await postJson(
      restartedPublicPort,
      '/v1/messages/count_tokens',
      JSON.stringify({ model: 'mimo/mimo-v2.5', messages: [{ role: 'user', content: 'ping' }] }),
      { authorization: `Bearer ${rotatedKey}` },
    );
    assert.equal(newAfterRestart.status, 200);
  } finally {
    if (child) await stopChild(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test('returns 413 from the live admin Node bridge before parsing an oversized body', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freebuff-admin-limit-'));
  const credentialsDirectory = join(directory, 'credentials');
  await mkdir(credentialsDirectory);
  const publicPort = await unusedPort();
  const adminPort = await unusedPort();
  const projectDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectDirectory,
    windowsHide: true,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(publicPort),
      FREEBUFF_API_KEY: 'process-test-api-key',
      FREEBUFF_TOKEN: '',
      FREEBUFF_PROXY_URL: '',
      CODEBUFF_API: '',
      RELAY_KEY: '',
      CREDENTIALS_DIR: credentialsDirectory,
      ADMIN_ENABLED: 'true',
      ADMIN_HOST: '127.0.0.1',
      ADMIN_PORT: String(adminPort),
      ADMIN_MAX_REQUEST_BODY_BYTES: '128',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'process-test-admin-password',
      ADMIN_COOKIE_SECURE: 'false',
      ACCOUNT_STORE_KEY: '81'.repeat(32),
      ACCOUNT_DB_PATH: join(directory, 'accounts.sqlite'),
      ACCOUNT_PROXY_RETIRE_MS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForOutput(child, `[admin] listening on 127.0.0.1:${adminPort}`);
    const response = await postJson(
      adminPort,
      '/admin/api/login',
      JSON.stringify({ padding: 'x'.repeat(256) }),
    );
    assert.equal(response.status, 413);
    assert.equal(response.headers.connection, 'close');
    assert.equal(JSON.parse(response.body).error.type, 'request_too_large');
  } finally {
    await stopChild(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not parse the legacy credential file after its one-time import completed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freebuff-admin-legacy-restart-'));
  const credentialsDirectory = join(directory, 'credentials');
  const credentialFile = join(credentialsDirectory, 'legacy.json');
  const projectDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
  await mkdir(credentialsDirectory);
  await writeFile(credentialFile, JSON.stringify({
    name: 'Legacy restart account',
    authToken: 'legacy-restart-token-12345',
    enabled: false,
  }));

  const baseEnv = {
    ...process.env,
    HOST: '127.0.0.1',
    FREEBUFF_API_KEY: 'legacy-restart-api-key',
    FREEBUFF_TOKEN: '',
    FREEBUFF_PROXY_URL: '',
    CODEBUFF_API: '',
    RELAY_KEY: '',
    CREDENTIALS_DIR: credentialsDirectory,
    REQUIRE_ACCOUNT_PROXY: 'false',
    ADMIN_ENABLED: 'true',
    ADMIN_HOST: '127.0.0.1',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'legacy-restart-admin-password',
    ADMIN_COOKIE_SECURE: 'false',
    ACCOUNT_STORE_KEY: '91'.repeat(32),
    ACCOUNT_DB_PATH: join(directory, 'accounts.sqlite'),
    ACCOUNT_PROXY_RETIRE_MS: '1',
  };
  let child;

  try {
    const firstPublicPort = await unusedPort();
    const firstAdminPort = await unusedPort();
    child = spawn(process.execPath, ['server.js'], {
      cwd: projectDirectory,
      windowsHide: true,
      env: { ...baseEnv, PORT: String(firstPublicPort), ADMIN_PORT: String(firstAdminPort) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForOutput(child, `[admin] listening on 127.0.0.1:${firstAdminPort}`);
    await stopChild(child);

    await writeFile(credentialFile, '{this is intentionally invalid JSON');
    const secondPublicPort = await unusedPort();
    const secondAdminPort = await unusedPort();
    child = spawn(process.execPath, ['server.js'], {
      cwd: projectDirectory,
      windowsHide: true,
      env: { ...baseEnv, PORT: String(secondPublicPort), ADMIN_PORT: String(secondAdminPort) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForOutput(child, `[admin] listening on 127.0.0.1:${secondAdminPort}`);
  } finally {
    if (child) await stopChild(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test('loads a rotated API key from encrypted storage after restart without the bootstrap env value', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freebuff-admin-api-key-restart-'));
  const credentialsDirectory = join(directory, 'credentials');
  const projectDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
  await mkdir(credentialsDirectory);
  const baseEnv = {
    ...process.env,
    HOST: '127.0.0.1',
    FREEBUFF_API_KEY: 'bootstrap-api-key-for-restart',
    FREEBUFF_API_KEY_FILE: '',
    FREEBUFF_TOKEN: '',
    FREEBUFF_PROXY_URL: '',
    CODEBUFF_API: '',
    RELAY_KEY: '',
    CREDENTIALS_DIR: credentialsDirectory,
    REQUIRE_ACCOUNT_PROXY: 'false',
    ADMIN_ENABLED: 'true',
    ADMIN_HOST: '127.0.0.1',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'restart-api-key-admin-password',
    ADMIN_PASSWORD_FILE: '',
    ADMIN_COOKIE_SECURE: 'false',
    ACCOUNT_STORE_KEY: 'b1'.repeat(32),
    ACCOUNT_STORE_KEY_FILE: '',
    ACCOUNT_DB_PATH: join(directory, 'accounts.sqlite'),
    ACCOUNT_PROXY_RETIRE_MS: '1',
    WORKER_UPDATE_MODE: 'bundled',
  };
  const rotatedKey = 'rotated-api-key-that-survives-restart';
  let child = null;

  try {
    const firstPublicPort = await unusedPort();
    const firstAdminPort = await unusedPort();
    child = spawn(process.execPath, ['server.js'], {
      cwd: projectDirectory,
      windowsHide: true,
      env: { ...baseEnv, PORT: String(firstPublicPort), ADMIN_PORT: String(firstAdminPort) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForOutput(child, `[admin] listening on 127.0.0.1:${firstAdminPort}`);

    const login = await postJson(
      firstAdminPort,
      '/admin/api/login',
      JSON.stringify({ username: 'admin', password: 'restart-api-key-admin-password' }),
    );
    assert.equal(login.status, 200);
    const loginPayload = JSON.parse(login.body);
    const cookieHeader = login.headers['set-cookie'].map((value) => value.split(';', 1)[0]).join('; ');
    const rotated = await requestJsonMethod(
      firstAdminPort,
      '/admin/api/api-key',
      'PUT',
      JSON.stringify({ apiKey: rotatedKey }),
      { cookie: cookieHeader, 'x-csrf-token': loginPayload.csrfToken },
    );
    assert.equal(rotated.status, 200);
    assert.equal(JSON.parse(rotated.body).apiKey.apiKey, rotatedKey);
    await stopChild(child);
    child = null;

    const secondPublicPort = await unusedPort();
    const secondAdminPort = await unusedPort();
    child = spawn(process.execPath, ['server.js'], {
      cwd: projectDirectory,
      windowsHide: true,
      env: {
        ...baseEnv,
        FREEBUFF_API_KEY: '',
        PORT: String(secondPublicPort),
        ADMIN_PORT: String(secondAdminPort),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForOutput(child, `[admin] listening on 127.0.0.1:${secondAdminPort}`);

    const oldKey = await requestJsonMethod(
      secondPublicPort,
      '/v1/models',
      'GET',
      undefined,
      { authorization: 'Bearer bootstrap-api-key-for-restart' },
    );
    assert.equal(oldKey.status, 401);
    const newKey = await requestJsonMethod(
      secondPublicPort,
      '/v1/models',
      'GET',
      undefined,
      { authorization: `Bearer ${rotatedKey}` },
    );
    assert.equal(newKey.status, 200);
  } finally {
    if (child) await stopChild(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test('trusted proxy mode rate limits forwarded clients independently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freebuff-admin-trusted-proxy-'));
  const credentialsDirectory = join(directory, 'credentials');
  await mkdir(credentialsDirectory);
  const publicPort = await unusedPort();
  const adminPort = await unusedPort();
  const projectDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectDirectory,
    windowsHide: true,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(publicPort),
      FREEBUFF_API_KEY: 'trusted-proxy-api-key',
      FREEBUFF_TOKEN: '',
      FREEBUFF_PROXY_URL: '',
      CREDENTIALS_DIR: credentialsDirectory,
      REQUIRE_ACCOUNT_PROXY: 'false',
      ADMIN_ENABLED: 'true',
      ADMIN_HOST: '127.0.0.1',
      ADMIN_PORT: String(adminPort),
      ADMIN_TRUST_PROXY: 'true',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'trusted-proxy-admin-password',
      ACCOUNT_STORE_KEY: 'a1'.repeat(32),
      ACCOUNT_DB_PATH: join(directory, 'accounts.sqlite'),
      ACCOUNT_PROXY_RETIRE_MS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForOutput(child, `[admin] listening on 127.0.0.1:${adminPort}`);
    const badBody = JSON.stringify({ username: 'admin', password: 'incorrect-password-value' });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const denied = await postJson(adminPort, '/admin/api/login', badBody, {
        'x-forwarded-for': '198.51.100.20',
      });
      assert.equal(denied.status, 401);
    }
    const limited = await postJson(adminPort, '/admin/api/login', badBody, {
      'x-forwarded-for': '198.51.100.20',
    });
    assert.equal(limited.status, 429);

    const allowed = await postJson(
      adminPort,
      '/admin/api/login',
      JSON.stringify({ username: 'admin', password: 'trusted-proxy-admin-password' }),
      { 'x-forwarded-for': '198.51.100.21' },
    );
    assert.equal(allowed.status, 200);
  } finally {
    await stopChild(child);
    await rm(directory, { recursive: true, force: true });
  }
});
