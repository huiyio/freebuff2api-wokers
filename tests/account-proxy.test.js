import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AccountProxyConfigError,
  AccountProxyRequestError,
  createAccountProxyRouter,
  createAccountRoute,
  installReloadableAccountProxyFetch,
  loadCredentialAccounts,
  loadCredentialRecords,
  normalizeTokenEntry,
  parseProtectedHosts,
  probeAccountConnection,
} from '../account-proxy.js';

const TOKEN_A = 'test-token-account-a';
const TOKEN_B = 'test-token-account-b';

test('rejects account delimiters inside one managed token entry', () => {
  assert.throws(
    () => normalizeTokenEntry('first-managed-token,second-injected-token', 'web account'),
    /cannot contain commas or line breaks/,
  );
  assert.throws(
    () => normalizeTokenEntry('first-managed-token\nsecond-injected-token', 'web account'),
    /cannot contain commas or line breaks/,
  );
});

test('probes an optional direct account without installing a proxy dispatcher', async () => {
  const account = createAccountRoute({
    token: TOKEN_A,
    source: 'direct-account',
    proxyRequired: false,
  });
  const result = await probeAccountConnection(account, {
    testUrl: 'https://fixed.test/',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://fixed.test/');
      assert.equal(init.method, 'HEAD');
      assert.equal(Object.hasOwn(init, 'dispatcher'), false);
      return new Response(null, { status: 204 });
    },
  });

  assert.deepEqual({ ok: result.ok, mode: result.mode, httpStatus: result.httpStatus }, {
    ok: true,
    mode: 'direct',
    httpStatus: 204,
  });
  assert.match(result.message, /direct connection/i);

  const failed = await probeAccountConnection(account, {
    fetchImpl: async () => { throw new Error('unsafe direct failure detail'); },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.mode, 'direct');
  assert.equal(failed.code, 'ACCOUNT_CONNECTION_ERROR');
  assert.doesNotMatch(failed.message, /unsafe direct failure detail/);
});

test('pins one proxy router generation for the full async operation', async () => {
  const seenDispatchers = [];
  const fetchImpl = async (_input, init) => {
    seenDispatchers.push(init.dispatcher);
    return new Response('ok');
  };
  const route = (proxyUrl) => createAccountRoute({
    token: TOKEN_A,
    tokenEntry: TOKEN_A,
    source: 'test',
    proxyUrl,
    proxyRequired: true,
  });
  const manager = installReloadableAccountProxyFetch(
    [route('http://127.0.0.1:18080')],
    { fetchImpl, retireMs: 60000 },
  );

  try {
    await manager.runWithCurrent(async () => {
      await globalThis.fetch('https://www.codebuff.com/first', {
        headers: { authorization: `Bearer ${TOKEN_A}` },
      });
      manager.reload([route('http://127.0.0.1:18081')]);
      await Promise.resolve();
      await globalThis.fetch('https://www.codebuff.com/second', {
        headers: { authorization: `Bearer ${TOKEN_A}` },
      });
    });
    await globalThis.fetch('https://www.codebuff.com/third', {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });

    assert.equal(seenDispatchers.length, 3);
    assert.equal(seenDispatchers[1], seenDispatchers[0]);
    assert.notEqual(seenDispatchers[2], seenDispatchers[0]);
  } finally {
    manager.restore();
    await manager.close();
  }
});

test('does not close a leased router after immediate or repeated reloads', async () => {
  const target = createTarget();
  const expectedAuthorization = `Basic ${Buffer.from('lease-user:lease-pass').toString('base64')}`;
  const proxy = createHttpConnectProxy(expectedAuthorization);
  const targetPort = await listen(target.server);
  const proxyPort = await listen(proxy.server);
  const route = () => createAccountRoute({
    token: TOKEN_A,
    tokenEntry: TOKEN_A,
    source: 'lease-test',
    proxyUrl: `http://lease-user:lease-pass@127.0.0.1:${proxyPort}`,
    proxyRequired: true,
  });
  const manager = installReloadableAccountProxyFetch([route()], { retireMs: 0 });

  try {
    await manager.runWithCurrent(async () => {
      const first = await globalThis.fetch(`http://127.0.0.1:${targetPort}/first`, {
        headers: { authorization: `Bearer ${TOKEN_A}` },
      });
      assert.match(await first.text(), /first[\s\S]*second/);

      for (let index = 0; index < 17; index++) manager.reload([route()]);

      const second = await globalThis.fetch(`http://127.0.0.1:${targetPort}/second`, {
        headers: { authorization: `Bearer ${TOKEN_A}` },
      });
      assert.match(await second.text(), /first[\s\S]*second/);
    });
    assert.equal(target.state.hits, 2);
    assert.ok(proxy.state.hits >= 1);
  } finally {
    manager.restore();
    await manager.close();
    await Promise.all([closeServer(proxy.server), closeServer(target.server)]);
  }
});

function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
}

function createTarget() {
  const state = { hits: 0, leakedProxyAuthorization: false };
  const server = createHttpServer((request, response) => {
    state.hits += 1;
    state.leakedProxyAuthorization ||= Boolean(request.headers['proxy-authorization']);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: first\n\n');
    setTimeout(() => response.end('data: second\n\n'), 5);
  });
  return { server, state };
}

function createHttpConnectProxy(expectedAuthorization) {
  const state = { hits: 0, rejected: 0 };
  const server = createHttpServer((request, response) => {
    response.writeHead(405).end();
  });

  server.on('connect', (request, clientSocket, head) => {
    if (request.headers['proxy-authorization'] !== expectedAuthorization) {
      state.rejected += 1;
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }

    state.hits += 1;
    const destination = new URL(`http://${request.url}`);
    const upstream = netConnect(Number(destination.port), destination.hostname);
    upstream.once('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.once('error', () => clientSocket.destroy());
    clientSocket.once('error', () => upstream.destroy());
  });

  return { server, state };
}

function createHangingConnectProxy() {
  const state = { hits: 0, destinations: [], sockets: new Set() };
  const server = createHttpServer();
  server.on('connection', (socket) => {
    state.sockets.add(socket);
    socket.once('close', () => state.sockets.delete(socket));
  });
  server.on('connect', (request) => {
    state.hits += 1;
    state.destinations.push(request.url);
  });
  return {
    server,
    state,
    destroySockets() {
      for (const socket of state.sockets) socket.destroy();
    },
  };
}

function createTlsStallingConnectProxy() {
  const state = { hits: 0, destinations: [], sockets: new Set() };
  const server = createHttpServer();
  server.on('connection', (socket) => {
    state.sockets.add(socket);
    socket.once('close', () => state.sockets.delete(socket));
  });
  server.on('connect', (request, clientSocket) => {
    state.hits += 1;
    state.destinations.push(request.url);
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  });
  return {
    server,
    state,
    destroySockets() {
      for (const socket of state.sockets) socket.destroy();
    },
  };
}

function parseSocksDestination(buffer) {
  if (buffer.length < 5) return null;
  const addressType = buffer[3];
  let offset = 4;
  let host;

  if (addressType === 1) {
    if (buffer.length < offset + 4 + 2) return null;
    host = [...buffer.subarray(offset, offset + 4)].join('.');
    offset += 4;
  } else if (addressType === 3) {
    const length = buffer[offset];
    offset += 1;
    if (buffer.length < offset + length + 2) return null;
    host = buffer.subarray(offset, offset + length).toString('utf8');
    offset += length;
  } else {
    throw new Error(`unsupported SOCKS address type ${addressType}`);
  }

  const port = buffer.readUInt16BE(offset);
  return { host, port, consumed: offset + 2 };
}

function createSocks5Proxy(expectedUsername, expectedPassword) {
  const state = { hits: 0, destinations: [], rejected: 0 };
  const server = createNetServer((clientSocket) => {
    let stage = 'greeting';
    let pending = Buffer.alloc(0);

    const rejectClient = (reply) => {
      state.rejected += 1;
      clientSocket.end(reply);
    };

    const onData = (chunk) => {
      pending = Buffer.concat([pending, chunk]);

      while (true) {
        if (stage === 'greeting') {
          if (pending.length < 2) return;
          const methodCount = pending[1];
          if (pending.length < 2 + methodCount) return;
          const methods = pending.subarray(2, 2 + methodCount);
          pending = pending.subarray(2 + methodCount);
          if (!methods.includes(2)) return rejectClient(Buffer.from([5, 255]));
          clientSocket.write(Buffer.from([5, 2]));
          stage = 'auth';
          continue;
        }

        if (stage === 'auth') {
          if (pending.length < 2) return;
          const usernameLength = pending[1];
          if (pending.length < 2 + usernameLength + 1) return;
          const passwordLength = pending[2 + usernameLength];
          const authLength = 3 + usernameLength + passwordLength;
          if (pending.length < authLength) return;
          const username = pending.subarray(2, 2 + usernameLength).toString('utf8');
          const password = pending.subarray(3 + usernameLength, authLength).toString('utf8');
          pending = pending.subarray(authLength);
          if (username !== expectedUsername || password !== expectedPassword) {
            return rejectClient(Buffer.from([1, 1]));
          }
          clientSocket.write(Buffer.from([1, 0]));
          stage = 'request';
          continue;
        }

        if (stage === 'request') {
          const destination = parseSocksDestination(pending);
          if (!destination) return;
          pending = pending.subarray(destination.consumed);
          state.hits += 1;
          state.destinations.push(destination.host);

          const upstream = netConnect(destination.port, destination.host);
          upstream.once('connect', () => {
            clientSocket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            clientSocket.off('data', onData);
            if (pending.length) upstream.write(pending);
            clientSocket.pipe(upstream);
            upstream.pipe(clientSocket);
          });
          upstream.once('error', () => clientSocket.destroy());
          clientSocket.once('error', () => upstream.destroy());
          stage = 'connecting';
          return;
        }

        return;
      }
    };

    clientSocket.on('data', onData);
  });

  return { server, state };
}

async function readWebStream(response) {
  assert.equal(typeof response.body?.getReader, 'function');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

test('loads single and aggregated credential files with strict validation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freebuff-credentials-'));
  try {
    await writeFile(join(directory, 'account-a.json'), `\uFEFF${JSON.stringify({
      authToken: TOKEN_A,
      proxyUrl: 'http://user:pass@127.0.0.1:8080',
      proxyRequired: true,
    })}`);
    const accounts = loadCredentialAccounts(directory);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].token, TOKEN_A);
    assert.equal(accounts[0].proxy.protocol, 'http:');
    assert.equal(accounts[0].proxyRequired, true);

    await writeFile(join(directory, 'combined.json'), JSON.stringify({
      accounts: {
        one: {
          name: 'Account B',
          authToken: TOKEN_B,
          proxyUrl: 'socks5://user:pass@127.0.0.1:1080',
          proxyRequired: true,
        },
      },
    }));
    const combined = loadCredentialAccounts(directory);
    assert.equal(combined.length, 2);
    assert.equal(combined[1].token, TOKEN_B);
    assert.equal(combined[1].name, 'Account B');
    assert.equal(combined[1].proxy.protocol, 'socks5:');

    const records = loadCredentialRecords(directory);
    assert.equal(records[1].source, 'combined.json:one');
    assert.equal(records[1].proxyUrl, 'socks5://user:pass@127.0.0.1:1080');

    await writeFile(join(directory, 'unsafe.json'), JSON.stringify({ accounts: [] }));
    assert.throws(
      () => loadCredentialAccounts(directory),
      (error) => error instanceof AccountProxyConfigError && /accounts must be an object/.test(error.message),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('routes two accounts through their own authenticated HTTP and SOCKS5 proxies', async () => {
  const target = createTarget();
  const httpProxyAuth = `Basic ${Buffer.from('http-user:http-pass').toString('base64')}`;
  const httpProxy = createHttpConnectProxy(httpProxyAuth);
  const socksProxy = createSocks5Proxy('socks-user', 'socks-pass');
  const targetPort = await listen(target.server);
  const httpProxyPort = await listen(httpProxy.server);
  const socksProxyPort = await listen(socksProxy.server);

  const accounts = [
    createAccountRoute({
      token: TOKEN_A,
      source: 'account-a.json',
      proxyUrl: `http://http-user:http-pass@127.0.0.1:${httpProxyPort}`,
      proxyRequired: true,
    }),
    createAccountRoute({
      token: TOKEN_B,
      source: 'account-b.json',
      proxyUrl: `socks5://socks-user:socks-pass@127.0.0.1:${socksProxyPort}`,
      proxyRequired: true,
    }),
  ];
  const router = createAccountProxyRouter(accounts, { requireProxy: true });

  try {
    const [httpResponse, socksResponse] = await Promise.all([
      router.fetch(new Request(`http://127.0.0.1:${targetPort}/http`, {
        headers: { Authorization: `Bearer ${TOKEN_A}` },
      })),
      router.fetch(`http://localhost:${targetPort}/socks`, {
        headers: new Headers({ Authorization: `Bearer ${TOKEN_B}` }),
      }),
    ]);
    assert.match(await readWebStream(httpResponse), /first[\s\S]*second/);
    assert.match(await readWebStream(socksResponse), /first[\s\S]*second/);
    assert.equal(httpProxy.state.hits, 1);
    assert.equal(socksProxy.state.hits, 1);
    assert.deepEqual(socksProxy.state.destinations, ['localhost']);
    assert.equal(target.state.hits, 2);
    assert.equal(target.state.leakedProxyAuthorization, false);
    assert.deepEqual(router.stats.proxyKinds, { http: 1, https: 0, socks5: 1 });
  } finally {
    await router.close();
    await Promise.all([
      closeServer(httpProxy.server),
      closeServer(socksProxy.server),
      closeServer(target.server),
    ]);
  }
});

test('fails closed without exposing proxy credentials', async () => {
  const target = createTarget();
  const deadProxy = createHttpConnectProxy('unused');
  const targetPort = await listen(target.server);
  const deadProxyPort = await listen(deadProxy.server);
  await closeServer(deadProxy.server);

  const account = createAccountRoute({
    token: TOKEN_A,
    source: 'account-a.json',
    proxyUrl: `http://secret-user:secret-pass@127.0.0.1:${deadProxyPort}`,
    proxyRequired: true,
  });
  const router = createAccountProxyRouter([account], { requireProxy: true });

  try {
    await assert.rejects(
      router.fetch(`http://127.0.0.1:${targetPort}/must-not-connect`, {
        headers: { Authorization: `Bearer ${TOKEN_A}` },
      }),
      (error) => {
        assert.ok(error instanceof AccountProxyRequestError);
        assert.doesNotMatch(error.message, /secret-user|secret-pass|127\.0\.0\.1/);
        return true;
      },
    );
    assert.equal(target.state.hits, 0);
  } finally {
    await router.close();
    await closeServer(target.server);
  }
});

test('times out a proxy that accepts TCP but never completes CONNECT', async () => {
  const hangingProxy = createHangingConnectProxy();
  const proxyPort = await listen(hangingProxy.server);
  const account = createAccountRoute({
    token: TOKEN_A,
    source: 'account-a.json',
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    proxyRequired: true,
  });
  const router = createAccountProxyRouter([account], {
    requireProxy: true,
    connectTimeoutMs: 50,
  });
  const started = Date.now();

  try {
    await assert.rejects(
      router.fetch('http://example.test/hang', {
        headers: { Authorization: `Bearer ${TOKEN_A}` },
      }),
      (error) => error instanceof AccountProxyRequestError && error.code === 'ETIMEDOUT',
    );
    assert.ok(Date.now() - started < 2000, 'CONNECT timeout must be bounded');
    assert.equal(hangingProxy.state.hits, 1);
    assert.deepEqual(hangingProxy.state.destinations, ['example.test:80']);
  } finally {
    await router.close();
    hangingProxy.destroySockets();
    await closeServer(hangingProxy.server);
  }
});

test('times out a stalled TLS handshake after CONNECT succeeds', async () => {
  const proxy = createTlsStallingConnectProxy();
  const proxyPort = await listen(proxy.server);
  const account = createAccountRoute({
    token: TOKEN_A,
    source: 'account-a.json',
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    proxyRequired: true,
  });
  const router = createAccountProxyRouter([account], {
    requireProxy: true,
    connectTimeoutMs: 50,
  });
  const started = Date.now();

  try {
    await assert.rejects(
      router.fetch('https://example.test/tls-stall', {
        headers: { Authorization: `Bearer ${TOKEN_A}` },
      }),
      (error) => error instanceof AccountProxyRequestError && error.code === 'ETIMEDOUT',
    );
    assert.ok(Date.now() - started < 2000, 'TLS timeout must be bounded');
    assert.equal(proxy.state.hits, 1);
    assert.deepEqual(proxy.state.destinations, ['example.test:443']);
  } finally {
    await router.close();
    proxy.destroySockets();
    await closeServer(proxy.server);
  }
});

test('strict mode rejects direct accounts and unmapped Freebuff requests', async () => {
  const protectedHosts = parseProtectedHosts('relay.example.test');
  assert.ok(protectedHosts.has('www.codebuff.com'));
  assert.ok(protectedHosts.has('codebuff.com'));
  assert.ok(protectedHosts.has('relay.example.test'));

  const directAccount = createAccountRoute({ token: TOKEN_A, source: 'account-a.json' });
  assert.throws(
    () => createAccountProxyRouter([directAccount], { requireProxy: true }),
    (error) => error instanceof AccountProxyConfigError && /proxyUrl is missing/.test(error.message),
  );

  const router = createAccountProxyRouter([], {
    requireProxy: true,
    protectedHosts: new Set(['example.test']),
    fetchImpl: async () => {
      throw new Error('direct fetch must not run');
    },
  });
  await assert.rejects(
    router.fetch('https://example.test/api/v1/freebuff/session'),
    (error) => error instanceof AccountProxyRequestError && error.code === 'ACCOUNT_PROXY_REQUIRED',
  );
  await router.close();
});

test('token:uid credentials and inherited Request headers cannot bypass proxy routing', async () => {
  const tokenEntry = `${TOKEN_A}:test-user-id`;
  const account = createAccountRoute({
    token: TOKEN_A,
    tokenEntry,
    source: 'account-a.json',
    proxyUrl: 'http://127.0.0.1:8080',
    proxyRequired: true,
  });
  assert.equal(account.token, TOKEN_A);
  assert.equal(account.tokenEntry, tokenEntry);

  let calls = 0;
  const router = createAccountProxyRouter([account], {
    requireProxy: false,
    fetchImpl: async (_input, init) => {
      calls += 1;
      assert.ok(init.dispatcher, 'request must carry the account dispatcher');
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${TOKEN_A}`);
      return new Response('ok');
    },
  });

  try {
    const request = new Request('https://www.codebuff.com/api/v1/freebuff/session', {
      headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    const response = await router.fetch(request, { headers: undefined });
    assert.equal(await response.text(), 'ok');
    assert.equal(calls, 1);

    await assert.rejects(
      router.fetch('https://www.codebuff.com/api/v1/freebuff/session', {
        headers: { Authorization: 'Bearer unknown-token-value' },
      }),
      (error) => error instanceof AccountProxyRequestError && error.code === 'ACCOUNT_PROXY_REQUIRED',
    );
    assert.equal(calls, 1, 'unknown account must not reach direct fetch');
  } finally {
    await router.close();
  }
});
