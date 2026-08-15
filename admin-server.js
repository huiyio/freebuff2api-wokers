import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AdminAuthError } from './admin-auth.js';
import { AccountServiceError } from './account-manager.js';

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

function responseHeaders(extra = {}) {
  return { ...SECURITY_HEADERS, ...extra };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: responseHeaders({
      'content-type': 'application/json; charset=utf-8',
      ...extraHeaders,
    }),
  });
}

function withCookies(response, cookies) {
  for (const value of cookies || []) response.headers.append('set-cookie', value);
  return response;
}

function apiError(error) {
  const status = Number(error?.status) || 500;
  const publicError = error instanceof AdminAuthError || error instanceof AccountServiceError;
  const headers = {};
  if (error?.retryAfter) headers['retry-after'] = String(error.retryAfter);
  return json({
    error: {
      message: publicError ? error.message : 'internal admin service error',
      type: publicError ? error.code : 'ADMIN_INTERNAL_ERROR',
    },
  }, status, headers);
}

async function requestJson(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new AccountServiceError('content-type must be application/json', 415, 'ADMIN_CONTENT_TYPE_INVALID');
  }
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('object required');
    return body;
  } catch {
    throw new AccountServiceError('request body must be one JSON object', 400, 'ADMIN_JSON_INVALID');
  }
}

function staticAssets(uiDirectory) {
  return new Map([
    ['/admin/', {
      contentType: 'text/html; charset=utf-8',
      body: readFileSync(join(uiDirectory, 'index.html')),
    }],
    ['/admin/app.js', {
      contentType: 'text/javascript; charset=utf-8',
      body: readFileSync(join(uiDirectory, 'app.js')),
    }],
    ['/admin/styles.css', {
      contentType: 'text/css; charset=utf-8',
      body: readFileSync(join(uiDirectory, 'styles.css')),
    }],
  ]);
}

export function createAdminHandler({
  auth,
  accountService,
  uiDirectory,
  getAccountHealth = async () => [],
  getSystemInfo = () => ({}),
  getApiKeyInfo = () => ({ configured: false, masked: null, updatedAt: null }),
  rotateApiKey = () => { throw new AccountServiceError('API key management is unavailable', 503, 'ADMIN_API_KEY_UNAVAILABLE'); },
  onError = () => {},
}) {
  const assets = staticAssets(uiDirectory);

  return async function handleAdminRequest(request, context = {}) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/admin') {
        return new Response(null, {
          status: 302,
          headers: responseHeaders({ location: '/admin/' }),
        });
      }

      if (!path.startsWith('/admin/api/')) {
        const asset = assets.get(path);
        if (!asset || (request.method !== 'GET' && request.method !== 'HEAD')) {
          return json({ error: { message: 'not found', type: 'ADMIN_NOT_FOUND' } }, 404);
        }
        return new Response(request.method === 'HEAD' ? null : asset.body, {
          status: 200,
          headers: responseHeaders({ 'content-type': asset.contentType }),
        });
      }

      if (path === '/admin/api/login' && request.method === 'POST') {
        const body = await requestJson(request);
        const result = await auth.login(
          body.username,
          body.password,
          context.remoteAddress || 'unknown',
        );
        return withCookies(json({
          authenticated: true,
          username: result.username,
          csrfToken: result.csrfToken,
          expiresAt: result.expiresAt,
        }), result.cookies);
      }

      const session = auth.requireSession(request);
      if (!['GET', 'HEAD'].includes(request.method)) auth.requireCsrf(request, session);

      if (path === '/admin/api/session' && request.method === 'GET') {
        return json({
          authenticated: true,
          username: session.username,
          csrfToken: session.csrfToken,
          expiresAt: session.expiresAt,
        });
      }

      if (path === '/admin/api/logout' && request.method === 'POST') {
        return withCookies(json({ ok: true }), auth.logout(session));
      }

      if (path === '/admin/api/password' && request.method === 'PUT') {
        const body = await requestJson(request);
        const cookies = await auth.changePassword(body.currentPassword, body.nextPassword, session);
        return withCookies(json({ ok: true, reauthenticationRequired: true }), cookies);
      }

      if (path === '/admin/api/accounts' && request.method === 'GET') {
        let health = [];
        try { health = await getAccountHealth(); } catch {}
        return json({ accounts: accountService.list(health) });
      }

      if (path === '/admin/api/accounts' && request.method === 'POST') {
        const account = await accountService.create(await requestJson(request), session.actor);
        return json({ account }, 201);
      }

      const accountMatch = /^\/admin\/api\/accounts\/([^/]+)$/.exec(path);
      if (accountMatch && request.method === 'PUT') {
        const account = await accountService.update(
          decodeURIComponent(accountMatch[1]),
          await requestJson(request),
          session.actor,
        );
        return json({ account });
      }

      if (accountMatch && request.method === 'DELETE') {
        await accountService.delete(decodeURIComponent(accountMatch[1]), session.actor);
        return json({ ok: true });
      }

      const testMatch = /^\/admin\/api\/accounts\/([^/]+)\/test-proxy$/.exec(path);
      if (testMatch && request.method === 'POST') {
        const result = await accountService.testProxy(decodeURIComponent(testMatch[1]), session.actor);
        return json(result);
      }

      if (path === '/admin/api/audit' && request.method === 'GET') {
        return json({ entries: accountService.store.listAudit(url.searchParams.get('limit')) });
      }

      if (path === '/admin/api/system' && request.method === 'GET') {
        return json({ system: await getSystemInfo() });
      }

      if (path === '/admin/api/api-key' && request.method === 'GET') {
        return json({ apiKey: getApiKeyInfo() });
      }

      if (path === '/admin/api/api-key' && request.method === 'PUT') {
        const result = await rotateApiKey(await requestJson(request), session.actor);
        return json({ apiKey: result });
      }

      return json({ error: { message: 'not found', type: 'ADMIN_NOT_FOUND' } }, 404);
    } catch (error) {
      if (!(error instanceof AdminAuthError) && !(error instanceof AccountServiceError)) onError(error);
      return apiError(error);
    }
  };
}
