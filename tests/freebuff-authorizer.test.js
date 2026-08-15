import assert from 'node:assert/strict';
import test from 'node:test';
import { FreebuffAuthorizationError, FreebuffAuthorizer } from '../freebuff-authorizer.js';

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function fixture(responses, options = {}) {
  let now = 1_000;
  const requests = [];
  const created = [];
  const deleted = [];
  const activeAccounts = new Map();
  const audit = [];
  const accountService = {
    store: {
      appendAudit(entry) {
        audit.push(entry);
      },
    },
    async create(input, actor) {
      created.push({ input, actor });
      if (options.createGate) await options.createGate;
      if (options.createError) throw options.createError;
      const id = 'account-' + created.length;
      const account = {
        id,
        name: input.name,
        email: input.email,
        enabled: input.enabled,
        proxyRequired: true,
        hasProxy: false,
        authToken: input.authToken,
      };
      activeAccounts.set(id, account);
      return account;
    },
    async delete(id, actor) {
      deleted.push({ id, actor });
      if (options.deleteError) throw options.deleteError;
      activeAccounts.delete(id);
    },
  };
  const defaultResponse = () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const fetchImpl = options.fetchImpl || (async () => defaultResponse());
  const authorizer = new FreebuffAuthorizer({
    accountService,
    now: () => now,
    randomBytesFn: () => Buffer.from([1, 2, 3, 4, 5, 6]),
    randomId: options.randomId || (() => 'authorization-1'),
    pollTimeoutMs: options.pollTimeoutMs || 5 * 60 * 1000,
    pollIntervalMs: 5_000,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return fetchImpl(url, init, defaultResponse);
    },
  });
  return {
    authorizer,
    created,
    deleted,
    activeAccounts,
    audit,
    requests,
    advance(milliseconds) { now += milliseconds; },
  };
}

const session = { sessionHash: 'session-a', actor: 'admin', expiresAt: 2_000 };

test('stores a successful web authorization as a disabled encrypted account without exposing its token', async () => {
  const token = 'authorized-freebuff-token-123456';
  const loginUrl = 'https://www.codebuff.com/login?auth_code=one-time-code';
  const setup = fixture([
    jsonResponse(200, {
      loginUrl,
      fingerprintHash: 'fingerprint-hash-value',
      expiresAt: '2026-08-16T00:00:00.000Z',
    }),
    jsonResponse(401, { message: 'pending' }),
    jsonResponse(200, {
      user: { email: 'authorized@example.com', id: 'user-1', authToken: token },
    }),
  ]);

  const started = await setup.authorizer.start(session);
  assert.equal(started.authorization.status, 'starting');
  assert.equal(started.authorization.loginUrl, undefined);
  await nextTick();
  const pending = await setup.authorizer.poll(started.authorization.id, session);
  assert.equal(pending.authorization.status, 'pending');
  assert.equal(pending.authorization.loginUrl, loginUrl);
  assert.equal(setup.created.length, 0);
  assert.match(setup.requests[0].url, /\/api\/auth\/cli\/code$/);
  assert.equal(setup.requests[0].init.method, 'POST');
  assert.match(setup.requests[0].init.headers['user-agent'], /Chrome\/125/);
  assert.match(JSON.parse(setup.requests[0].init.body).fingerprintId, /^codebuff-cli-[A-Za-z0-9_-]{8}$/);

  setup.advance(5_000);
  const completed = await setup.authorizer.poll(started.authorization.id, session);
  assert.equal(completed.authorization.status, 'completed');
  assert.equal(completed.authorization.account.email, 'authorized@example.com');
  assert.equal(completed.authorization.account.enabled, false);
  assert.equal(setup.created.length, 1);
  assert.deepEqual(setup.created[0], {
    input: {
      name: 'authorized@example.com',
      email: 'authorized@example.com',
      authToken: token,
      enabled: false,
    },
    actor: 'admin',
  });
  assert.equal(setup.activeAccounts.size, 1);
  assert.doesNotMatch(JSON.stringify(completed), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(completed), /one-time-code|fingerprint-hash-value/);
  assert.doesNotMatch(JSON.stringify(setup.audit), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(setup.audit), /one-time-code|fingerprint-hash-value/);
  assert.match(setup.requests[2].url, /fingerprintId=codebuff-cli-AQIDBAUG/);
  assert.match(setup.requests[2].url, /fingerprintHash=fingerprint-hash-value/);
});

test('binds authorization records to one administrator session and supports cancellation', async () => {
  const setup = fixture([
    jsonResponse(200, {
      loginUrl: 'https://www.codebuff.com/login?auth_code=one-time-code',
      fingerprintHash: 'fingerprint-hash-value',
      expiresAt: '2026-08-16T00:00:00.000Z',
    }),
  ]);
  const started = await setup.authorizer.start(session);

  await assert.rejects(
    setup.authorizer.poll(started.authorization.id, { sessionHash: 'session-b', actor: 'admin' }),
    (error) => error instanceof FreebuffAuthorizationError && error.status === 404,
  );

  const cancelled = await setup.authorizer.cancel(started.authorization.id, session);
  assert.equal(cancelled.authorization.status, 'cancelled');
  assert.doesNotMatch(JSON.stringify(cancelled), /one-time-code|fingerprint-hash-value/);
  assert.match(JSON.stringify(setup.audit), /account.authorization_cancelled/);
});

test('expires invalid upstream authorization responses without retaining credentials', async () => {
  const setup = fixture([
    jsonResponse(200, {
      loginUrl: 'https://www.codebuff.com/login?auth_code=one-time-code',
      fingerprintHash: 'fingerprint-hash-value',
      expiresAt: '2026-08-16T00:00:00.000Z',
    }),
    jsonResponse(400, { message: 'expired' }),
  ]);
  const started = await setup.authorizer.start(session);
  await nextTick();
  const expired = await setup.authorizer.poll(started.authorization.id, session);
  assert.equal(expired.authorization.status, 'expired');
  assert.equal(setup.activeAccounts.size, 0);
  assert.doesNotMatch(JSON.stringify(expired), /one-time-code|fingerprint-hash-value/);
  assert.match(JSON.stringify(setup.audit), /account.authorization_expired/);
});

test('does not save a malformed or duplicate upstream credential', async () => {
  const malformed = fixture([
    jsonResponse(200, {
      loginUrl: 'https://www.codebuff.com/login?auth_code=one-time-code',
      fingerprintHash: 'fingerprint-hash-value',
      expiresAt: '2026-08-16T00:00:00.000Z',
    }),
    jsonResponse(200, { user: { email: 'bad@example.com' } }),
  ]);
  const startedMalformed = await malformed.authorizer.start(session);
  await nextTick();
  const malformedResult = await malformed.authorizer.poll(startedMalformed.authorization.id, session);
  assert.equal(malformedResult.authorization.status, 'failed');
  assert.equal(malformed.activeAccounts.size, 0);

  const duplicateError = Object.assign(new Error('duplicate'), { code: 'ACCOUNT_DUPLICATE' });
  const duplicate = fixture([
    jsonResponse(200, {
      loginUrl: 'https://www.codebuff.com/login?auth_code=one-time-code',
      fingerprintHash: 'fingerprint-hash-value',
      expiresAt: '2026-08-16T00:00:00.000Z',
    }),
    jsonResponse(200, { user: { email: 'duplicate@example.com', authToken: 'duplicate-token-12345' } }),
  ], { createError: duplicateError });
  const startedDuplicate = await duplicate.authorizer.start(session);
  await nextTick();
  const duplicateResult = await duplicate.authorizer.poll(startedDuplicate.authorization.id, session);
  assert.equal(duplicateResult.authorization.status, 'duplicate');
  assert.equal(duplicate.activeAccounts.size, 0);
  assert.doesNotMatch(JSON.stringify(duplicateResult), /duplicate-token-12345/);
});

test('turns an unexpected upstream login URL into a terminal result without retaining a record secret', async () => {
  const setup = fixture([
    jsonResponse(200, {
      loginUrl: 'https://example.invalid/login?auth_code=one-time-code',
      fingerprintHash: 'fingerprint-hash-value',
      expiresAt: '2026-08-16T00:00:00.000Z',
    }),
  ]);
  const started = await setup.authorizer.start(session);
  await nextTick();
  const result = await setup.authorizer.poll(started.authorization.id, session);
  assert.equal(result.authorization.status, 'failed');
  assert.doesNotMatch(JSON.stringify(result), /one-time-code|fingerprint-hash-value/);
});

test('coalesces concurrent starts for one administrator session', async () => {
  let resolveStart;
  const startResponse = new Promise((resolve) => { resolveStart = resolve; });
  const setup = fixture([], {
    fetchImpl: async (url, init, defaultResponse) => {
      if (new URL(url).pathname.endsWith('/api/auth/cli/code')) return startResponse;
      return defaultResponse();
    },
  });
  const firstPromise = setup.authorizer.start(session);
  await nextTick();
  const second = await setup.authorizer.start(session);
  assert.equal(second.authorization.id, (await firstPromise).authorization.id);
  assert.equal(setup.requests.filter((request) => request.url.endsWith('/api/auth/cli/code')).length, 1);
  resolveStart(jsonResponse(200, {
    loginUrl: 'https://www.codebuff.com/login?auth_code=one-time-code',
    fingerprintHash: 'fingerprint-hash-value',
    expiresAt: '2026-08-16T00:00:00.000Z',
  }));
  await nextTick();
  const ready = await setup.authorizer.poll(second.authorization.id, session);
  assert.equal(ready.authorization.status, 'pending');
});

test('cancellation is a terminal barrier for a blocked status poll', async () => {
  let resolveStatus;
  const statusResponse = new Promise((resolve) => { resolveStatus = resolve; });
  const setup = fixture([
    jsonResponse(200, {
      loginUrl: 'https://www.codebuff.com/login?auth_code=one-time-code',
      fingerprintHash: 'fingerprint-hash-value',
      expiresAt: '2026-08-16T00:00:00.000Z',
    }),
  ], {
    fetchImpl: async (url, init, defaultResponse) => {
      if (new URL(url).pathname.endsWith('/api/auth/cli/status')) return statusResponse;
      return defaultResponse();
    },
  });
  const started = await setup.authorizer.start(session);
  await nextTick();
  const polling = setup.authorizer.poll(started.authorization.id, session);
  await nextTick();
  const cancelling = setup.authorizer.cancel(started.authorization.id, session);
  assert.equal(setup.requests.at(-1).init.signal.aborted, true);
  resolveStatus(jsonResponse(200, {
    user: { email: 'cancelled@example.com', authToken: 'cancelled-token-12345' },
  }));
  const [polled, cancelled] = await Promise.all([polling, cancelling]);
  assert.equal(polled.authorization.status, 'cancelled');
  assert.equal(cancelled.authorization.status, 'cancelled');
  assert.equal(setup.activeAccounts.size, 0);
  assert.equal(setup.created.length, 0);
});

test('expiry is a terminal barrier for a blocked status poll', async () => {
  let resolveStatus;
  const statusResponse = new Promise((resolve) => { resolveStatus = resolve; });
  const setup = fixture([
    jsonResponse(200, {
      loginUrl: 'https://www.codebuff.com/login?auth_code=one-time-code',
      fingerprintHash: 'fingerprint-hash-value',
      expiresAt: '2026-08-16T00:00:00.000Z',
    }),
  ], {
    pollTimeoutMs: 5_000,
    fetchImpl: async (url, init, defaultResponse) => {
      if (new URL(url).pathname.endsWith('/api/auth/cli/status')) return statusResponse;
      return defaultResponse();
    },
  });
  const started = await setup.authorizer.start(session);
  await nextTick();
  const polling = setup.authorizer.poll(started.authorization.id, session);
  await nextTick();
  setup.advance(5_001);
  const expired = await setup.authorizer.poll(started.authorization.id, session);
  assert.equal(expired.authorization.status, 'expired');
  assert.equal(setup.requests.at(-1).init.signal.aborted, true);
  resolveStatus(jsonResponse(200, {
    user: { email: 'expired@example.com', authToken: 'expired-token-12345' },
  }));
  const result = await polling;
  assert.equal(result.authorization.status, 'expired');
  assert.equal(setup.activeAccounts.size, 0);
  assert.equal(setup.created.length, 0);
});

test('parallel polls share one upstream request and one account write', async () => {
  let resolveStatus;
  const statusResponse = new Promise((resolve) => { resolveStatus = resolve; });
  const setup = fixture([
    jsonResponse(200, {
      loginUrl: 'https://www.codebuff.com/login?auth_code=one-time-code',
      fingerprintHash: 'fingerprint-hash-value',
      expiresAt: '2026-08-16T00:00:00.000Z',
    }),
  ], {
    fetchImpl: async (url, init, defaultResponse) => {
      if (new URL(url).pathname.endsWith('/api/auth/cli/status')) return statusResponse;
      return defaultResponse();
    },
  });
  const started = await setup.authorizer.start(session);
  await nextTick();
  setup.advance(5_000);
  const first = setup.authorizer.poll(started.authorization.id, session);
  const second = setup.authorizer.poll(started.authorization.id, session);
  resolveStatus(jsonResponse(200, {
    user: { email: 'parallel@example.com', authToken: 'parallel-token-12345' },
  }));
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.authorization.status, 'completed');
  assert.equal(right.authorization.status, 'completed');
  assert.equal(setup.activeAccounts.size, 1);
  assert.equal(setup.created.length, 1);
  assert.equal(setup.requests.filter((request) => new URL(request.url).pathname.endsWith('/api/auth/cli/status')).length, 1);
});

test('does not keep an account when persistence crosses the authorization deadline', async () => {
  let releaseCreate;
  const createGate = new Promise((resolve) => { releaseCreate = resolve; });
  const setup = fixture([
    jsonResponse(200, {
      loginUrl: 'https://www.codebuff.com/login?auth_code=one-time-code',
      fingerprintHash: 'fingerprint-hash-value',
      expiresAt: '2026-08-16T00:00:00.000Z',
    }),
    jsonResponse(200, { user: { email: 'late@example.com', authToken: 'late-token-12345' } }),
  ], { pollTimeoutMs: 5_000, createGate });
  const started = await setup.authorizer.start(session);
  await nextTick();
  const polling = setup.authorizer.poll(started.authorization.id, session);
  while (setup.created.length === 0) await nextTick();
  setup.advance(5_001);
  releaseCreate();
  const result = await polling;
  assert.equal(result.authorization.status, 'expired');
  assert.equal(setup.deleted.length, 1);
  assert.equal(setup.activeAccounts.size, 0);
});

test('cancels and rolls back an account write already in progress', async () => {
  let releaseCreate;
  const createGate = new Promise((resolve) => { releaseCreate = resolve; });
  const setup = fixture([
    jsonResponse(200, {
      loginUrl: 'https://www.codebuff.com/login?auth_code=one-time-code',
      fingerprintHash: 'fingerprint-hash-value',
      expiresAt: '2026-08-16T00:00:00.000Z',
    }),
    jsonResponse(200, { user: { email: 'cancel-late@example.com', authToken: 'cancel-late-token-12345' } }),
  ], { createGate });
  const started = await setup.authorizer.start(session);
  await nextTick();
  const polling = setup.authorizer.poll(started.authorization.id, session);
  while (setup.created.length === 0) await nextTick();
  const cancelling = setup.authorizer.cancel(started.authorization.id, session);
  await nextTick();
  releaseCreate();
  const [polled, cancelled] = await Promise.all([polling, cancelling]);
  assert.equal(polled.authorization.status, 'cancelled');
  assert.equal(cancelled.authorization.status, 'cancelled');
  assert.equal(setup.deleted.length, 1);
  assert.equal(setup.activeAccounts.size, 0);
});

test('reports a failed terminal result when interrupted-account rollback fails', async () => {
  let releaseCreate;
  const createGate = new Promise((resolve) => { releaseCreate = resolve; });
  const setup = fixture([
    jsonResponse(200, {
      loginUrl: 'https://www.codebuff.com/login?auth_code=one-time-code',
      fingerprintHash: 'fingerprint-hash-value',
      expiresAt: '2026-08-16T00:00:00.000Z',
    }),
    jsonResponse(200, { user: { email: 'rollback-failed@example.com', authToken: 'rollback-failed-token-12345' } }),
  ], { createGate, deleteError: new Error('delete failed') });
  const started = await setup.authorizer.start(session);
  await nextTick();
  const polling = setup.authorizer.poll(started.authorization.id, session);
  while (setup.created.length === 0) await nextTick();
  const cancelling = setup.authorizer.cancel(started.authorization.id, session);
  releaseCreate();
  const [polled, cancelled] = await Promise.all([polling, cancelling]);
  assert.equal(polled.authorization.status, 'failed');
  assert.equal(cancelled.authorization.status, 'failed');
  assert.equal(setup.deleted.length, 1);
  assert.equal(setup.activeAccounts.size, 1);
});

test('blocks new authorizations while all revoked sessions are being drained', async () => {
  let releaseCreate;
  const createGate = new Promise((resolve) => { releaseCreate = resolve; });
  const setup = fixture([
    jsonResponse(200, {
      loginUrl: 'https://www.codebuff.com/login?auth_code=one-time-code',
      fingerprintHash: 'fingerprint-hash-value',
      expiresAt: '2026-08-16T00:00:00.000Z',
    }),
    jsonResponse(200, { user: { email: 'revoked@example.com', authToken: 'revoked-token-12345' } }),
  ], { createGate });
  const started = await setup.authorizer.start(session);
  await nextTick();
  const polling = setup.authorizer.poll(started.authorization.id, session);
  while (setup.created.length === 0) await nextTick();
  const revoking = setup.authorizer.cancelAll();
  await assert.rejects(
    setup.authorizer.start({ sessionHash: 'session-b', actor: 'admin', expiresAt: 2_000 }),
    (error) => error instanceof FreebuffAuthorizationError
      && error.code === 'FREEBUFF_AUTH_REVOCATION_IN_PROGRESS'
      && error.status === 503,
  );
  releaseCreate();
  const [polled, revoked] = await Promise.all([polling, revoking]);
  assert.equal(polled.authorization.status, 'cancelled');
  assert.equal(revoked.cancelled, 1);
  assert.equal(setup.activeAccounts.size, 0);
});
