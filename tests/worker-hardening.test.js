import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import worker from '../worker.js';

test('worker API fails closed when no API key is configured', async () => {
  const response = await worker.fetch(new Request('https://local.test/v1/models'), {
    FREEBUFF_TOKEN: 'configured-account-token-12345',
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.type, 'auth_error');
});

test('public health output is aggregate-only and authenticated details are sanitized', async () => {
  const token = 'secret-token-value-123456789';
  const env = {
    FREEBUFF_TOKEN: `${token}:private-user-id`,
    FREEBUFF_API_KEY: 'integration-api-key',
  };
  const response = await worker.fetch(new Request('https://local.test/healthz'), env);
  const payload = await response.json();
  const serialized = JSON.stringify(payload);

  assert.equal(response.status, 200);
  assert.doesNotMatch(serialized, /secret-to/);
  assert.doesNotMatch(serialized, /private-u/);
  assert.equal(payload.account_details, undefined);

  const authenticated = await worker.fetch(new Request('https://local.test/healthz', {
    headers: { Authorization: 'Bearer integration-api-key' },
  }), env);
  const authenticatedPayload = await authenticated.json();
  assert.deepEqual(
    authenticatedPayload.account_details,
    [{ account: 1, alive: null, state: 'unknown' }],
  );
  assert.doesNotMatch(JSON.stringify(authenticatedPayload), /secret-to|private-u/);
});

test('account mutations clear token state and expired health stops excluding an account', async () => {
  const source = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
  const instrumented = `${source}\nexport {\n  acctHealth, behaviorCache, cooldowns, invalidateAccountState, pickToken, recordAccountObservation,\n  runCache, scopedAccountKey, scopedCacheKey, sessCache, summarizeAccountHealth,\n};\n`;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(instrumented).toString('base64')}`;
  const internals = await import(moduleUrl);
  const firstToken = 'state-test-token-first-12345';
  const secondToken = 'state-test-token-second-12345';
  const env = { FREEBUFF_TOKEN: `${firstToken},${secondToken}` };
  const firstStateKey = internals.scopedAccountKey(firstToken, 'static');

  internals.recordAccountObservation(firstToken, 429, { status: 'rate_limited' }, {}, 'static');
  assert.equal(internals.pickToken(env, null).token, secondToken);

  const originalNow = Date.now;
  const observedAt = internals.acctHealth.get(firstStateKey).checkedAt;
  try {
    Date.now = () => observedAt + (10 * 60 * 1000) + 1;
    assert.equal(internals.pickToken(env, null).token, firstToken);
    assert.equal(internals.acctHealth.has(firstStateKey), false);
  } finally {
    Date.now = originalNow;
  }

  const sessionKey = internals.scopedCacheKey(firstToken, 'static', 'session:model');
  const runKey = internals.scopedCacheKey(firstToken, 'static', 'run:agent');
  const behaviorKey = internals.scopedCacheKey(firstToken, 'static', 'behavior:ads');
  internals.acctHealth.set(firstStateKey, { alive: false, state: 'banned', checkedAt: Date.now() });
  internals.cooldowns.set(firstStateKey, Date.now() + 10000);
  internals.sessCache.set(sessionKey, { instanceId: 'session' });
  internals.runCache.set(runKey, { runId: 'run', ts: Date.now() });
  internals.behaviorCache.set(behaviorKey, Date.now());
  internals.invalidateAccountState([firstToken], secondToken);

  assert.equal(internals.acctHealth.has(firstStateKey), false);
  assert.equal(internals.cooldowns.has(firstStateKey), false);
  assert.equal(internals.sessCache.has(sessionKey), false);
  assert.equal(internals.runCache.has(runKey), false);
  assert.equal(internals.behaviorCache.has(behaviorKey), false);
  assert.deepEqual(
    internals.summarizeAccountHealth([{ token: secondToken }], internals.acctHealth).account_details,
    [{ account: 1, alive: null, state: 'unknown' }],
  );
});

test('cached sessions do not bypass an account cooldown', async () => {
  const source = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
  const instrumented = `${source}\nexport { cooldowns, pickToken, sessCache, scopedAccountKey, scopedCacheKey };\n`;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(instrumented).toString('base64')}`;
  const internals = await import(moduleUrl);
  const firstToken = 'cooldown-cache-token-first-12345';
  const secondToken = 'cooldown-cache-token-second-12345';
  const model = 'test-model';
  const generation = '1';
  const env = {
    FREEBUFF_TOKEN: `${firstToken},${secondToken}`,
    FREEBUFF_ACCOUNT_GENERATION: generation,
  };

  internals.sessCache.set(
    internals.scopedCacheKey(firstToken, generation, `session:${model}`),
    { instanceId: 'cooldown-session', expiresAt: new Date(Date.now() + 3600000).toISOString() },
  );
  internals.cooldowns.set(internals.scopedAccountKey(firstToken, generation), Date.now() + 60000);

  assert.equal(internals.pickToken(env, model).token, secondToken);
});

test('an invalidated request cannot write session or run caches into a newer generation', { timeout: 6000 }, async () => {
  const source = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
  const instrumented = `${source}\nexport {\n  acctHealth, behaviorCache, createSession, invalidateAccountState, pickToken, runCache, sessCache, startRunChain,\n};\n`;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(instrumented).toString('base64')}`;
  const internals = await import(moduleUrl);
  const token = 'generation-race-token-12345';
  const originalFetch = globalThis.fetch;
  let resolveSessionResponse;
  let markSessionStarted;
  const sessionStarted = new Promise((resolvePromise) => { markSessionStarted = resolvePromise; });
  const sessionResponse = new Promise((resolvePromise) => { resolveSessionResponse = resolvePromise; });
  let agentRunCalls = 0;
  let resolveChildRun;
  let markChildStarted;
  const childStarted = new Promise((resolvePromise) => { markChildStarted = resolvePromise; });
  const childRunResponse = new Promise((resolvePromise) => { resolveChildRun = resolvePromise; });

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/v1/ads') return Response.json({ ads: [] });
    if (url.pathname === '/api/v1/usage') return Response.json({ ok: true });
    if (url.pathname === '/api/v1/freebuff/session' && (init.method || 'GET') === 'GET') {
      markSessionStarted();
      return sessionResponse;
    }
    if (url.pathname === '/api/v1/agent-runs') {
      agentRunCalls += 1;
      if (agentRunCalls === 1) return Response.json({ runId: 'root-run' });
      markChildStarted();
      return childRunResponse;
    }
    throw new Error(`unexpected test request: ${url.pathname}`);
  };

  try {
    internals.pickToken({
      FREEBUFF_TOKEN: token,
      FREEBUFF_ACCOUNT_GENERATION: '1',
    }, null);
    const pendingSession = internals.createSession(token, 'test-model', false, '1');
    await sessionStarted;
    internals.invalidateAccountState([token], token, '2');
    resolveSessionResponse(Response.json({
      status: 'active',
      instanceId: 'old-generation-session',
      model: 'test-model',
      remainingMs: 3600000,
    }));
    assert.equal((await pendingSession).instanceId, 'old-generation-session');
    assert.equal([...internals.sessCache.keys()].some((key) => key.startsWith(`${token}\u0000`)), false);
    assert.equal([...internals.acctHealth.keys()].some((key) => key.startsWith(`${token}\u0000`)), false);
    assert.equal([...internals.behaviorCache.keys()].some((key) => key.startsWith(`${token}\u0000`)), false);

    internals.pickToken({
      FREEBUFF_TOKEN: token,
      FREEBUFF_ACCOUNT_GENERATION: '3',
    }, null);
    const pendingRun = internals.startRunChain(token, 'test-agent', '3');
    await childStarted;
    internals.invalidateAccountState([token], token, '4');
    resolveChildRun(Response.json({ runId: 'child-run' }));
    assert.equal((await pendingRun).runId, 'root-run');
    assert.equal([...internals.runCache.keys()].some((key) => key.startsWith(`${token}\u0000`)), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('concurrent session creation is serialized and reuses the first active session', { timeout: 10000 }, async () => {
  const source = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
  const instrumented = `${source}\nexport { behaviorCache, createSession, pickToken, sessCache, scopedCacheKey };\n`;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(instrumented).toString('base64')}`;
  const internals = await import(moduleUrl);
  const token = 'session-concurrency-token-12345';
  const model = 'test-model';
  const generation = '1';
  const originalFetch = globalThis.fetch;
  let getCalls = 0;
  let postCalls = 0;

  // Skip the optional client-behavior requests so this test isolates session locking.
  const now = Date.now();
  internals.behaviorCache.set(internals.scopedCacheKey(token, generation, 'behavior:ads'), now);
  internals.behaviorCache.set(internals.scopedCacheKey(token, generation, 'behavior:usage'), now);

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname !== '/api/v1/freebuff/session') {
      throw new Error(`unexpected test request: ${url.pathname}`);
    }
    if ((init.method || 'GET') === 'GET') {
      getCalls += 1;
      return Response.json({ status: 'not_found' }, { status: 404 });
    }
    postCalls += 1;
    return Response.json({
      status: 'active',
      instanceId: 'shared-session',
      model,
      remainingMs: 3600000,
    });
  };

  try {
    internals.pickToken({ FREEBUFF_TOKEN: token, FREEBUFF_ACCOUNT_GENERATION: generation }, null);
    const [first, second] = await Promise.all([
      internals.createSession(token, model, false, generation),
      internals.createSession(token, model, false, generation),
    ]);
    assert.equal(getCalls, 1);
    assert.equal(postCalls, 1);
    assert.equal(first.instanceId, 'shared-session');
    assert.equal(second.instanceId, 'shared-session');
    assert.equal(
      internals.sessCache.get(internals.scopedCacheKey(token, generation, `session:${model}`)).instanceId,
      'shared-session',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('transformed streaming pumps cancel their source readers on downstream failure', async () => {
  const source = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
  const clientPump = source.slice(
    source.indexOf('function pipeUpstreamToClient'),
    source.indexOf('// 非流式：聚合上游流成 OpenAI 非流式对象'),
  );
  const responsesPump = source.slice(
    source.indexOf('async function pipeUpstreamToResponsesStream'),
    source.indexOf('// 非流式：聚合上游流成 Responses API 非流式对象'),
  );

  assert.match(clientPump, /catch \(error\)[\s\S]*reader\.cancel\(error\)/);
  assert.match(responsesPump, /catch \(error\)[\s\S]*reader\.cancel\(error\)/);
});

test('Responses stream cancellation reaches the real upstream source', { timeout: 3000 }, async () => {
  const source = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
  const instrumented = `${source}\nexport { pipeUpstreamToResponsesStream };\n`;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(instrumented).toString('base64')}`;
  const { pipeUpstreamToResponsesStream } = await import(moduleUrl);

  let sourceController;
  let cancelReason;
  let resolveCanceled;
  const canceled = new Promise((resolvePromise) => { resolveCanceled = resolvePromise; });
  const upstream = new ReadableStream({
    start(controller) {
      sourceController = controller;
    },
    cancel(reason) {
      cancelReason = reason;
      resolveCanceled();
    },
  });
  const { readable, writable } = new TransformStream();
  const downstream = readable.getReader();

  pipeUpstreamToResponsesStream(upstream, writable, { id: 'test-model' });
  await downstream.read(); // response.created
  await downstream.read(); // response.in_progress

  sourceController.enqueue(new TextEncoder().encode(
    'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
  ));
  const outputItem = await downstream.read();
  assert.match(new TextDecoder().decode(outputItem.value), /response\.output_item\.added/);

  await downstream.cancel(new Error('downstream canceled'));
  const wasCanceled = await Promise.race([
    canceled.then(() => true),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 500)),
  ]);

  if (!wasCanceled) {
    try { sourceController.close(); } catch {}
  }
  assert.equal(wasCanceled, true);
  assert.ok(cancelReason instanceof Error);
});
