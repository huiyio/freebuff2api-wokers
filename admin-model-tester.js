import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AccountProxyRequestError,
  createAccountProxyRouter,
  createAccountRoute,
} from './account-proxy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CODEBUFF_API = 'https://www.codebuff.com';
const DEFAULT_TEST_TIMEOUT_MS = 30000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const MAX_CLEANUP_TIMEOUT_MS = 5000;
const MAX_PREVIEW_LENGTH = 240;
const MAX_UPSTREAM_BODY_LENGTH = 64 * 1024;
const CONTEXT_PRUNER_AGENT = 'context-pruner';
const BUFFY_SYSTEM_PROMPT = 'You are Buffy, the strategic coding assistant.';

function stableClientId(token) {
  return `enhanced-${createHash('sha256').update(`freebuff-admin-test:${token}`).digest('hex').slice(0, 32)}`;
}

/**
 * Public error used for validation/configuration failures. Upstream failures
 * are returned as a result so the admin UI can show the actual test outcome
 * without turning a normal failed probe into an opaque 500 response.
 */
export class ModelTestError extends Error {
  constructor(message, status = 400, code = 'MODEL_TEST_FAILED') {
    super(message);
    this.name = 'ModelTestError';
    this.status = status;
    this.code = code;
  }
}

// Kept as the public name used by the account service integration. It is an
// alias (rather than a subclass) so errors raised by either API are translated
// consistently without exposing upstream details.
export { ModelTestError as AdminModelTestError };

class UpstreamResponseError extends Error {
  constructor(status, text, data, stage) {
    super(`upstream ${stage} request failed`);
    this.name = 'UpstreamResponseError';
    this.status = status;
    this.text = text;
    this.data = data;
    this.stage = stage;
  }
}

class ModelTestTimeoutError extends Error {
  constructor() {
    super('model test timed out');
    this.name = 'ModelTestTimeoutError';
  }
}

function safeText(value, max = MAX_UPSTREAM_BODY_LENGTH) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length <= max ? text : text.slice(0, max);
}

function parseJson(text) {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function normalizeModel(model, source = 'freebuff-models.json') {
  if (!model || typeof model !== 'object' || Array.isArray(model)) return null;
  const id = typeof model.id === 'string' ? model.id.trim() : '';
  const session = typeof model.session === 'string' && model.session.trim()
    ? model.session.trim()
    : id;
  const upstream = typeof model.upstream === 'string' && model.upstream.trim()
    ? model.upstream.trim()
    : id;
  const agent = typeof model.agent === 'string' && model.agent.trim()
    ? model.agent.trim()
    : (typeof model.root_agent === 'string' ? model.root_agent.trim() : '');
  if (!id || !session || !upstream || !agent) return null;
  if (id.length > 256 || session.length > 256 || upstream.length > 256 || agent.length > 256) return null;
  if (/[,\r\n\0]/.test(id + session + upstream + agent)) return null;
  return Object.freeze({
    id,
    session,
    upstream,
    agent,
    label: typeof model.label === 'string' ? model.label.trim().slice(0, 120) : null,
  });
}

export function loadTestModels(file = resolve(__dirname, 'freebuff-models.json')) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`unable to load model catalog: ${error?.message || 'invalid file'}`);
  }
  if (!parsed || !Array.isArray(parsed.models)) return [];
  const seen = new Set();
  const models = [];
  for (const value of parsed.models) {
    const model = normalizeModel(value);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

function modelCatalog(models) {
  const source = Array.isArray(models) ? models : loadTestModels();
  const seen = new Set();
  const normalized = [];
  for (const value of source) {
    const model = normalizeModel(value, 'model options');
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    normalized.push(model);
  }
  return normalized;
}

function bodyIndicatesBanned(text, data) {
  const visit = (value, depth = 0) => {
    if (depth > 6 || value === null || value === undefined) return false;
    if (typeof value === 'string') return value.toLowerCase() === 'banned';
    if (typeof value !== 'object') return false;
    return Object.entries(value).some(([key, child]) =>
      ['status', 'state', 'code'].includes(key.toLowerCase()) && typeof child === 'string' && child.toLowerCase() === 'banned'
      || visit(child, depth + 1));
  };
  if (visit(data)) return true;
  // Only inspect non-success upstream bodies. A successful model response is
  // never classified as a ban merely because it contains the word "banned".
  return /["']status["']?\s*:\s*["']banned["']/i.test(text)
    || /\baccount\s+(?:is\s+)?banned\b/i.test(text)
    || /\buser\s+banned\b/i.test(text);
}

function bodyIncludes(text, ...terms) {
  const value = String(text || '').toLowerCase();
  return terms.some((term) => value.includes(term));
}

export function classifyModelTestFailure(error) {
  if (error instanceof ModelTestError) return { code: error.code, status: error.status };
  if (error instanceof ModelTestTimeoutError || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return { code: 'MODEL_TEST_TIMEOUT', status: 504, upstreamState: 'error', message: 'model test timed out' };
  }
  if (error instanceof AccountProxyRequestError) {
    if (error.code === 'ACCOUNT_PROXY_REQUIRED') {
      return { code: 'ACCOUNT_PROXY_MISSING', status: 400, upstreamState: 'error', message: 'configure a proxy before testing this account' };
    }
    return { code: 'ACCOUNT_PROXY_UNREACHABLE', status: 502, upstreamState: 'error', message: 'account proxy could not reach Freebuff' };
  }
  if (error instanceof UpstreamResponseError) {
    const text = safeText(error.text);
    if (error.status === 403 && bodyIndicatesBanned(text, error.data)) {
      return {
        code: 'FREEBUFF_BANNED',
        status: 200,
        upstreamState: 'banned',
        httpStatus: error.status,
        banned: true,
        message: 'Freebuff marked this account as banned',
      };
    }
    if ([409, 410, 428, 502].includes(error.status) && bodyIncludes(text, 'session_model_mismatch', 'session superseded', 'waiting_room_required', 'session_expired', 'not valid for limited access')) {
      return {
        code: 'MODEL_SESSION_MISMATCH',
        status: 200,
        upstreamState: 'error',
        httpStatus: error.status,
        message: 'the selected model does not match the account session',
      };
    }
    if (error.status === 401) {
      return {
        code: 'MODEL_TOKEN_INVALID',
        status: 200,
        upstreamState: 'token_invalid',
        httpStatus: error.status,
        message: 'the Freebuff token is invalid or expired',
      };
    }
    if (error.status === 403) {
      return {
        code: 'MODEL_ACCESS_BLOCKED',
        status: 200,
        upstreamState: 'blocked',
        httpStatus: error.status,
        message: 'Freebuff rejected this account',
      };
    }
    if (error.status === 400 && bodyIncludes(text, 'model not available', 'unsupported_model', 'unknown model', 'not found')) {
      return {
        code: 'MODEL_UNAVAILABLE',
        status: 200,
        upstreamState: 'error',
        httpStatus: error.status,
        message: 'the selected model is unavailable upstream',
      };
    }
    if (error.status === 429 || bodyIncludes(text, 'quota', 'rate limit', 'session_limit_reached', 'too many requests', 'limit reached')) {
      return {
        code: 'MODEL_QUOTA_EXHAUSTED',
        status: 200,
        upstreamState: 'quota_exhausted',
        httpStatus: error.status,
        message: 'the account has no available quota for this model',
      };
    }
    return {
      code: 'MODEL_TEST_FAILED',
      status: 200,
      upstreamState: 'error',
      httpStatus: error.status,
      message: error.status >= 500 ? 'Freebuff returned a server error' : 'Freebuff rejected the model test',
    };
  }
  return {
    code: 'MODEL_TEST_FAILED',
    status: 200,
    upstreamState: 'error',
    message: 'model test failed',
  };
}

function cleanPreview(value, secrets = []) {
  let text = String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const secret of secrets) {
    const valueToHide = String(secret || '');
    if (valueToHide.length > 0) text = text.split(valueToHide).join('[redacted]');
  }
  if (text.length > MAX_PREVIEW_LENGTH) text = `${text.slice(0, MAX_PREVIEW_LENGTH - 3)}...`;
  return text;
}

function extractText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  if (value.data && typeof value.data === 'object') return extractText(value.data);
  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string') return value.content;
  const choice = Array.isArray(value.choices) ? value.choices[0] : null;
  if (choice) {
    if (typeof choice.text === 'string') return choice.text;
    if (typeof choice.delta?.content === 'string') return choice.delta.content;
    if (typeof choice.message?.content === 'string') return choice.message.content;
  }
  if (typeof value.output_text === 'string') return value.output_text;
  return '';
}

function responsePreview(text, secrets = []) {
  const chunks = [];
  const parsed = parseJson(text);
  const direct = extractText(parsed);
  if (direct) chunks.push(direct);
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^data:\s*(.+)$/.exec(line.trim());
    if (!match || match[1] === '[DONE]') continue;
    const data = parseJson(match[1]);
    const value = extractText(data);
    if (value) chunks.push(value);
  }
  return cleanPreview(chunks.join(''), secrets);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function requestHeaders(token, extra = {}) {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    ...extra,
  };
}

function remainingTimeout(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ModelTestTimeoutError();
  return remaining;
}

async function readBody(response) {
  let text = '';
  try {
    text = await response.text();
  } catch {
    text = '';
  }
  return safeText(text);
}

function routeForAccount(account, requireProxy) {
  if (!account || typeof account !== 'object') {
    throw new ModelTestError('account not found', 404, 'ACCOUNT_NOT_FOUND');
  }
  if (!account.authToken) {
    throw new ModelTestError('account token is unavailable', 409, 'ACCOUNT_TOKEN_UNAVAILABLE');
  }
  if (!account.proxyUrl && (requireProxy || account.proxyRequired)) {
    throw new ModelTestError(
      'configure a proxy before testing this account because proxy routing is required',
      400,
      'ACCOUNT_PROXY_MISSING',
    );
  }
  try {
    return createAccountRoute({
      token: account.authToken,
      tokenEntry: account.authToken,
      source: account.id || 'account',
      proxyUrl: account.proxyUrl,
      proxyRequired: Boolean(account.proxyRequired || requireProxy),
    });
  } catch (error) {
    throw new ModelTestError('account proxy configuration is invalid', 400, 'ACCOUNT_PROXY_INVALID');
  }
}

function resultBase(account, model, startedAt) {
  return {
    accountId: account.id || null,
    model: model.id,
    ok: false,
    phase: 'session',
    upstreamState: 'error',
    httpStatus: null,
    latencyMs: Date.now() - startedAt,
    banned: false,
    responsePreview: '',
    code: 'MODEL_TEST_FAILED',
    message: 'model test failed',
  };
}

function applyFailure(result, failure, startedAt) {
  return {
    ...result,
    ok: false,
    upstreamState: failure.upstreamState || result.upstreamState || 'error',
    httpStatus: failure.httpStatus ?? result.httpStatus ?? null,
    latencyMs: Date.now() - startedAt,
    banned: Boolean(failure.banned),
    code: failure.code || 'MODEL_TEST_FAILED',
    message: failure.message || 'model test failed',
  };
}

export function createAdminModelTester({
  codebuffApi = DEFAULT_CODEBUFF_API,
  models = null,
  modelFile,
  fetchImpl,
  requireProxy = false,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  testTimeoutMs = DEFAULT_TEST_TIMEOUT_MS,
  pollIntervalMs = 1000,
} = {}) {
  const baseUrl = String(codebuffApi || DEFAULT_CODEBUFF_API).replace(/\/$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) throw new ModelTestError('CODEBUFF_API must be an http(s) URL', 500, 'MODEL_TEST_CONFIG_INVALID');
  const catalog = modelCatalog(models || loadTestModels(modelFile));
  const byId = new Map(catalog.map((model) => [model.id, model]));
  const upstreamFetch = fetchImpl;

  const listModels = () => catalog.map((model) => ({
    id: model.id,
    session: model.session,
    agent: model.agent,
    upstream: model.upstream,
    ...(model.label ? { label: model.label } : {}),
  }));

  async function test(account, requestedModel, options = {}) {
    const modelId = typeof requestedModel === 'string' ? requestedModel.trim() : '';
    if (!modelId || modelId.length > 256 || /[\r\n\0]/.test(modelId)) {
      throw new ModelTestError('model is required', 400, 'MODEL_INVALID');
    }
    const model = byId.get(modelId);
    if (!model) throw new ModelTestError('selected model is unavailable', 400, 'MODEL_UNAVAILABLE');
    const route = routeForAccount(account, Boolean(options.requireProxy ?? requireProxy));
    const startedAt = Date.now();
    const result = resultBase(account, model, startedAt);
    const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
      ? Math.min(options.timeoutMs, 120000)
      : testTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    const pollMs = Number.isInteger(options.pollIntervalMs) && options.pollIntervalMs >= 100
      ? Math.min(options.pollIntervalMs, 5000)
      : pollIntervalMs;
    let router;
    let session = null;
    let createdSession = false;
    let rootRunId = null;
    let childRunId = null;

    try {
      router = createAccountProxyRouter([route], {
        requireProxy: Boolean(options.requireProxy ?? requireProxy),
        connectTimeoutMs,
        fetchImpl: upstreamFetch,
      });

      const request = async (method, path, body, headers = {}) => {
        const timeout = remainingTimeout(deadline);
        let response;
        try {
          response = await router.fetch(`${baseUrl}${path}`, {
            method,
            headers: requestHeaders(route.token, headers),
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(timeout),
          });
        } catch (error) {
          if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT') {
            throw new ModelTestTimeoutError();
          }
          throw error;
        }
        const text = await readBody(response);
        const data = parseJson(text);
        if (!response.ok) throw new UpstreamResponseError(response.status, text, data, path);
        return { status: response.status, text, data };
      };

      // Reuse an already-active session only when it is for the selected model.
      // This avoids deleting a user's live session and avoids burning a fresh
      // session quota for every admin click.
      let current;
      try {
        current = await request('GET', '/api/v1/freebuff/session', undefined, {
          'x-freebuff-include-unused-rate-limits': '1',
        });
      } catch (error) {
        if (!(error instanceof UpstreamResponseError) || ![404, 409].includes(error.status)) throw error;
      }
      if (current?.data?.status === 'active' && current.data.instanceId) {
        const currentModel = current.data.model;
        if (currentModel && currentModel !== model.session) {
          throw new UpstreamResponseError(409, JSON.stringify({ error: 'session_model_mismatch' }), { error: 'session_model_mismatch' }, '/api/v1/freebuff/session');
        }
        session = {
          instanceId: current.data.instanceId,
          model: currentModel || model.session,
        };
      }

      if (!session) {
        const instanceId = randomUUID();
        const created = await request('POST', '/api/v1/freebuff/session', undefined, {
          'x-freebuff-model': model.session,
          'x-freebuff-instance-id': instanceId,
        });
        if (created.data?.status === 'active' && created.data.instanceId) {
          session = { instanceId: created.data.instanceId, model: model.session };
          createdSession = true;
        } else if (created.data?.status === 'queued' && created.data.instanceId) {
          const queuedId = created.data.instanceId;
          // A queued instance already occupies upstream state. Mark it for
          // cleanup before polling so timeout/error paths cannot strand it.
          session = { instanceId: queuedId, model: model.session };
          createdSession = true;
          for (;;) {
            await sleep(Math.min(pollMs, remainingTimeout(deadline)));
            const polled = await request('GET', '/api/v1/freebuff/session', undefined, {
              'x-freebuff-instance-id': queuedId,
            });
            if (polled.data?.status === 'active' && polled.data.instanceId) {
              session = { instanceId: polled.data.instanceId, model: model.session };
              createdSession = true;
              break;
            }
            if (polled.data?.status !== 'queued') {
              throw new UpstreamResponseError(polled.status, polled.text, polled.data, '/api/v1/freebuff/session');
            }
          }
        } else {
          throw new UpstreamResponseError(created.status, created.text, created.data, '/api/v1/freebuff/session');
        }
      }

      result.phase = 'run';
      const startRun = async (agentId, ancestors = []) => {
        const run = await request('POST', '/api/v1/agent-runs', {
          action: 'START',
          agentId,
          ancestorRunIds: ancestors,
        });
        if (run.status !== 200 || !run.data?.runId) {
          throw new UpstreamResponseError(run.status, run.text, run.data, '/api/v1/agent-runs');
        }
        return run.data.runId;
      };

      rootRunId = await startRun(model.agent);
      childRunId = await startRun(CONTEXT_PRUNER_AGENT, [rootRunId]);

      result.phase = 'chat';
      const chat = await request('POST', '/api/v1/chat/completions', {
        model: model.upstream,
        messages: [
          { role: 'system', content: BUFFY_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
          { role: 'user', content: 'Reply with exactly: OK' },
        ],
        stream: true,
        stop: ['"cb_easp"'],
        provider: { data_collection: 'deny' },
        codebuff_metadata: {
          freebuff_instance_id: session.instanceId,
          trace_session_id: randomUUID(),
          run_id: rootRunId,
          client_id: stableClientId(route.token),
          cost_mode: 'free',
        },
      }, {
        'x-freebuff-instance-id': session.instanceId,
      });
      const preview = responsePreview(chat.text, [route.token, route.tokenEntry]);
      if (!preview) {
        throw new ModelTestError('Freebuff returned no model text', 200, 'MODEL_TEST_FAILED');
      }
      return {
        ...result,
        ok: true,
        upstreamState: 'ok',
        httpStatus: chat.status,
        latencyMs: Date.now() - startedAt,
        banned: false,
        responsePreview: preview,
        code: 'MODEL_TEST_OK',
        message: 'model request succeeded',
      };
    } catch (error) {
      const failure = classifyModelTestFailure(error);
      return applyFailure(result, failure, startedAt);
    } finally {
      // The run records are only bookkeeping. Finish both when possible, and
      // remove sessions created by this probe so a failed test cannot strand a
      // waiting-room slot. Never delete a session that predated the test.
      const finish = async (runId) => {
        if (!runId || !router) return;
        try {
          await router.fetch(`${baseUrl}/api/v1/agent-runs`, {
            method: 'POST',
            headers: requestHeaders(route.token),
            body: JSON.stringify({
              action: 'FINISH',
              runId,
              status: 'completed',
              totalSteps: 1,
              directCredits: 0,
              totalCredits: 0,
            }),
            signal: AbortSignal.timeout(Math.min(MAX_CLEANUP_TIMEOUT_MS, connectTimeoutMs)),
          });
        } catch {}
      };
      await Promise.allSettled([finish(childRunId), finish(rootRunId)]);
      if (createdSession && session?.instanceId && router) {
        try {
          await router.fetch(`${baseUrl}/api/v1/freebuff/session`, {
            method: 'DELETE',
            headers: requestHeaders(route.token, { 'x-freebuff-instance-id': session.instanceId }),
            signal: AbortSignal.timeout(Math.min(MAX_CLEANUP_TIMEOUT_MS, connectTimeoutMs)),
          });
        } catch {}
      }
      try { await router?.close?.(); } catch {}
    }
  }

  return Object.freeze({
    listModels,
    test,
    models: listModels(),
  });
}

// Compatibility helpers for the account-management layer. The tester itself
// remains factory-based so tests and deployments can inject an upstream URL or
// fetch implementation without mutating global fetch state.
export function listTestModels(options = {}) {
  return modelCatalog(options.models || loadTestModels(options.modelFile)).map((model) => ({
    id: model.id,
    session: model.session,
    agent: model.agent,
    upstream: model.upstream,
    ...(model.label ? { label: model.label } : {}),
  }));
}

export async function testAccountModel(account, model, options = {}) {
  const tester = createAdminModelTester({
    codebuffApi: options.codebuffApi || options.upstreamBaseUrl || DEFAULT_CODEBUFF_API,
    models: options.models,
    modelFile: options.modelFile,
    fetchImpl: options.fetchImpl,
    requireProxy: Boolean(options.requireProxy),
    connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    testTimeoutMs: options.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
    pollIntervalMs: options.pollIntervalMs,
  });
  const result = await tester.test(account, model, options);
  // `category` is a stable UI/audit alias; `code` remains the canonical API
  // field for callers that need machine-readable classification.
  const categories = {
    MODEL_TEST_OK: 'ok',
    FREEBUFF_BANNED: 'banned',
    MODEL_SESSION_MISMATCH: 'session_mismatch',
    MODEL_UNAVAILABLE: 'model_unavailable',
    MODEL_QUOTA_EXHAUSTED: 'quota_exhausted',
    MODEL_TOKEN_INVALID: 'token_invalid',
    MODEL_ACCESS_BLOCKED: 'blocked',
    MODEL_TEST_TIMEOUT: 'timeout',
    ACCOUNT_PROXY_MISSING: 'proxy_missing',
    ACCOUNT_PROXY_UNREACHABLE: 'proxy_error',
  };
  return { ...result, category: categories[result.code] || result.code };
}
