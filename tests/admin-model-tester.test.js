import assert from 'node:assert/strict';
import test from 'node:test';
import { listTestModels, testAccountModel } from '../admin-model-tester.js';

const ACCOUNT = {
  id: 'model-test-account',
  authToken: 'model-test-token-12345',
  enabled: true,
  proxyRequired: false,
  proxyUrl: null,
};

const DISABLED_ACCOUNT = { ...ACCOUNT, enabled: false };

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('lists the local testable model catalog without credentials', () => {
  const models = listTestModels();
  assert.ok(models.some((model) => model.id === 'deepseek/deepseek-v4-flash'));
  assert.ok(models.every((model) => !Object.hasOwn(model, 'token')));
  assert.ok(models.every((model) => !Object.hasOwn(model, 'proxyUrl')));
});

test('runs a short model test through one specified account and redacts protocol secrets', async () => {
  const calls = [];
  const result = await testAccountModel(ACCOUNT, 'mimo/mimo-v2.5', {
    upstreamBaseUrl: 'https://upstream.test',
    fetchImpl: async (url, init) => {
      const requestUrl = new URL(url);
      const headers = new Headers(init.headers);
      calls.push({
        path: requestUrl.pathname,
        method: init.method,
        body: init.body ? JSON.parse(init.body) : null,
        authorization: headers.get('authorization'),
      });
      if (requestUrl.pathname === '/api/v1/freebuff/session' && init.method === 'GET') {
        return new Response('not found', { status: 404 });
      }
      if (requestUrl.pathname === '/api/v1/freebuff/session' && init.method === 'POST') {
        return jsonResponse({ status: 'active', instanceId: 'test-session-instance' });
      }
      if (requestUrl.pathname === '/api/v1/agent-runs' && init.method === 'POST') {
        const body = JSON.parse(init.body);
        if (body.action === 'START') {
          return jsonResponse({ runId: body.agentId === 'context-pruner' ? 'test-child-run' : 'test-root-run' });
        }
        return jsonResponse({ ok: true });
      }
      if (requestUrl.pathname === '/api/v1/chat/completions') {
        return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (requestUrl.pathname === '/api/v1/freebuff/session' && init.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected route ${init.method} ${requestUrl.pathname}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.category, 'ok');
  assert.equal(result.phase, 'chat');
  assert.equal(result.model, 'mimo/mimo-v2.5');
  assert.equal(result.responsePreview, 'OK');
  assert.equal(result.banned, false);
  assert.doesNotMatch(JSON.stringify(result), /model-test-token|test-session-instance|test-root-run/);
  assert.ok(calls.every((call) => call.authorization === 'Bearer model-test-token-12345'));
  const chat = calls.find((call) => call.path === '/api/v1/chat/completions');
  assert.equal(chat.body.model, 'mimo/mimo-v2.5');
  assert.equal(chat.body.stream, true);
  assert.equal(chat.body.messages[0].content.startsWith('You are Buffy,'), true);
  assert.equal(chat.body.codebuff_metadata.freebuff_instance_id, 'test-session-instance');
});

test('classifies a banned account without exposing the upstream response', async () => {
  const result = await testAccountModel(ACCOUNT, 'mimo/mimo-v2.5', {
    upstreamBaseUrl: 'https://upstream.test',
    fetchImpl: async () => jsonResponse({ status: 'banned', debugToken: 'model-test-token-12345' }, 403),
  });

  assert.equal(result.ok, false);
  assert.equal(result.category, 'banned');
  assert.equal(result.phase, 'session');
  assert.equal(result.banned, true);
  assert.equal(result.httpStatus, 403);
  assert.doesNotMatch(JSON.stringify(result), /model-test-token/);
});

test('does not replace an active session for a different model', async () => {
  let posts = 0;
  const result = await testAccountModel(ACCOUNT, 'mimo/mimo-v2.5', {
    upstreamBaseUrl: 'https://upstream.test',
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      if (path === '/api/v1/freebuff/session' && init.method === 'GET') {
        return jsonResponse({ status: 'active', instanceId: 'other-session', model: 'deepseek/deepseek-v4-flash' });
      }
      posts += 1;
      return jsonResponse({});
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.category, 'session_mismatch');
  assert.equal(result.phase, 'session');
  assert.equal(posts, 0);
  assert.doesNotMatch(JSON.stringify(result), /other-session/);
});

test('deletes a queued session when polling times out', async () => {
  const calls = [];
  let sessionGets = 0;
  const result = await testAccountModel(DISABLED_ACCOUNT, 'mimo/mimo-v2.5', {
    upstreamBaseUrl: 'https://upstream.test',
    pollIntervalMs: 100,
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      const headers = new Headers(init.headers);
      calls.push({ path, method: init.method, instanceId: headers.get('x-freebuff-instance-id') });
      if (path === '/api/v1/freebuff/session' && init.method === 'GET') {
        sessionGets += 1;
        if (sessionGets === 1) return new Response('not found', { status: 404 });
        throw Object.assign(new Error('poll timed out'), { name: 'TimeoutError' });
      }
      if (path === '/api/v1/freebuff/session' && init.method === 'POST') {
        return jsonResponse({ status: 'queued', instanceId: 'queued-session-id' });
      }
      if (path === '/api/v1/freebuff/session' && init.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected route ${init.method} ${path}`);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.category, 'timeout');
  assert.equal(result.phase, 'session');
  assert.deepEqual(calls.at(-1), {
    path: '/api/v1/freebuff/session',
    method: 'DELETE',
    instanceId: 'queued-session-id',
  });
  assert.doesNotMatch(JSON.stringify(result), /queued-session-id/);
});

test('fails a model test when an SSE response ends with only DONE', async () => {
  const calls = [];
  const result = await testAccountModel(DISABLED_ACCOUNT, 'mimo/mimo-v2.5', {
    upstreamBaseUrl: 'https://upstream.test',
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      if (path === '/api/v1/freebuff/session' && init.method === 'GET') {
        return new Response('not found', { status: 404 });
      }
      if (path === '/api/v1/freebuff/session' && init.method === 'POST') {
        return jsonResponse({ status: 'active', instanceId: 'empty-sse-session-id' });
      }
      if (path === '/api/v1/agent-runs' && init.method === 'POST') {
        const body = JSON.parse(init.body);
        if (body.action === 'START') {
          return jsonResponse({ runId: body.agentId === 'context-pruner' ? 'empty-sse-child' : 'empty-sse-root' });
        }
        return jsonResponse({ ok: true });
      }
      if (path === '/api/v1/chat/completions' && init.method === 'POST') {
        return new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (path === '/api/v1/freebuff/session' && init.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected route ${init.method} ${path}`);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'MODEL_TEST_FAILED');
  assert.equal(result.phase, 'chat');
  assert.equal(result.responsePreview, '');
  assert.ok(calls.some((call) => call.path === '/api/v1/chat/completions'));
});
