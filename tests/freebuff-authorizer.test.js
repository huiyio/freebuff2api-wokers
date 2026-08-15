import assert from 'node:assert/strict';
import test from 'node:test';
import { FreebuffAuthorizationError, FreebuffAuthorizer } from '../freebuff-authorizer.js';

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fixture(responses, options = {}) {
  let now = 1_000;
  const requests = [];
  const created = [];
  const audit = [];
  const accountService = {
    store: {
      appendAudit(entry) {
        audit.push(entry);
      },
    },
    async create(input, actor) {
      created.push({ input, actor });
      if (options.createError) throw options.createError;
      return {
        id: `account-${created.length}`,
        name: input.name,
        email: input.email,
        enabled: input.enabled,
        proxyRequired: true,
        hasProxy: false,
        authToken: input.authToken,
      };
    },
  };
  const authorizer = new FreebuffAuthorizer({
    accountService,
    now: () => now,
    randomBytesFn: () => Buffer.from([1, 2, 3, 4, 5, 6]),
    randomId: () => 'authorization-1',
    pollIntervalMs: 5_000,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return {
    authorizer,
    created,
    audit,
    requests,
    advance(milliseconds) { now += milliseconds; },
  };
}

const session = { sessionHash: 'session-a', actor: 'admin' };

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
  assert.equal(started.authorization.loginUrl, loginUrl);
  assert.equal(started.authorization.status, 'pending');
  assert.match(setup.requests[0].url, /\/api\/auth\/cli\/code$/);
  assert.equal(setup.requests[0].init.method, 'POST');
  assert.match(setup.requests[0].init.headers['user-agent'], /Chrome\/125/);
  assert.match(JSON.parse(setup.requests[0].init.body).fingerprintId, /^codebuff-cli-[A-Za-z0-9_-]{8}$/);

  const pending = await setup.authorizer.poll(started.authorization.id, session);
  assert.equal(pending.authorization.status, 'pending');
  assert.equal(setup.created.length, 0);

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

  const cancelled = setup.authorizer.cancel(started.authorization.id, session);
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
  const expired = await setup.authorizer.poll(started.authorization.id, session);
  assert.equal(expired.authorization.status, 'expired');
  assert.equal(setup.created.length, 0);
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
  const malformedResult = await malformed.authorizer.poll(startedMalformed.authorization.id, session);
  assert.equal(malformedResult.authorization.status, 'failed');
  assert.equal(malformed.created.length, 0);

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
  const duplicateResult = await duplicate.authorizer.poll(startedDuplicate.authorization.id, session);
  assert.equal(duplicateResult.authorization.status, 'duplicate');
  assert.doesNotMatch(JSON.stringify(duplicateResult), /duplicate-token-12345/);
});

test('rejects an unexpected upstream login URL before keeping a pending record', async () => {
  const setup = fixture([
    jsonResponse(200, {
      loginUrl: 'https://example.invalid/login?auth_code=one-time-code',
      fingerprintHash: 'fingerprint-hash-value',
      expiresAt: '2026-08-16T00:00:00.000Z',
    }),
  ]);
  await assert.rejects(
    setup.authorizer.start(session),
    (error) => error instanceof FreebuffAuthorizationError && error.code === 'FREEBUFF_AUTH_RESPONSE_INVALID',
  );
});
