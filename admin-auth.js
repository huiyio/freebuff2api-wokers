import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { Buffer } from 'node:buffer';

const SESSION_COOKIE = 'freebuff_admin_session';
const CSRF_COOKIE = 'freebuff_admin_csrf';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const PASSWORD_MIN_LENGTH = 12;
const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 128;

export class AdminAuthError extends Error {
  constructor(message, status = 401, code = 'ADMIN_UNAUTHORIZED', retryAfter = null) {
    super(message);
    this.name = 'AdminAuthError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function scryptAsync(password, salt, length, options) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function passwordValue(value) {
  const password = typeof value === 'string' ? value : '';
  if (password.length < PASSWORD_MIN_LENGTH || password.length > 256) {
    throw new AdminAuthError(
      `administrator password must be ${PASSWORD_MIN_LENGTH}-256 characters`,
      400,
      'ADMIN_PASSWORD_INVALID',
    );
  }
  return password;
}

function usernameValue(value) {
  const username = typeof value === 'string' ? value : '';
  if (
    username.length < USERNAME_MIN_LENGTH
    || username.length > USERNAME_MAX_LENGTH
    || /[\u0000-\u001f\u007f\s]/.test(username)
  ) {
    throw new AdminAuthError(
      `administrator username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters without whitespace`,
      400,
      'ADMIN_USERNAME_INVALID',
    );
  }
  return username;
}

async function hashPassword(password) {
  const checked = passwordValue(password);
  const salt = randomBytes(16);
  const derived = await scryptAsync(checked, salt, 32, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    Buffer.from(derived).toString('base64url'),
  ].join('$');
}

async function verifyPassword(password, encoded) {
  try {
    const [scheme, n, r, p, saltPart, hashPart, extra] = String(encoded || '').split('$');
    if (scheme !== 'scrypt' || !saltPart || !hashPart || extra !== undefined) return false;
    const expected = Buffer.from(hashPart, 'base64url');
    const actual = await scryptAsync(String(password || ''), Buffer.from(saltPart, 'base64url'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseCookies(request) {
  const result = {};
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function cookie(name, value, { maxAge, secure, httpOnly = false }) {
  const parts = [
    `${name}=${value}`,
    'Path=/admin',
    `Max-Age=${maxAge}`,
    'SameSite=Strict',
  ];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function constantTimeTextEqual(left, right) {
  const leftHash = createHash('sha256').update(String(left || '')).digest();
  const rightHash = createHash('sha256').update(String(right || '')).digest();
  return timingSafeEqual(leftHash, rightHash);
}

export async function initializeAdminAuth({
  store,
  initialUsername = 'admin',
  initialPassword,
  sessionTtlSeconds = 12 * 60 * 60,
  secureCookies = false,
  maxLoginAttempts = 5,
  loginWindowSeconds = 15 * 60,
}) {
  let username = store.getSetting('admin_username');
  const usernameMissing = !username;
  username = usernameValue(usernameMissing ? initialUsername : username);

  let passwordHash = store.getSetting('admin_password_hash');
  const passwordMissing = !passwordHash;
  if (passwordMissing) {
    if (!initialPassword) {
      throw new AdminAuthError(
        'ADMIN_PASSWORD is required the first time the admin service starts',
        500,
        'ADMIN_PASSWORD_REQUIRED',
      );
    }
    passwordHash = await hashPassword(initialPassword);
  }

  if (usernameMissing || passwordMissing) {
    store.transaction(() => {
      if (usernameMissing) store.setSetting('admin_username', username);
      if (passwordMissing) store.setSetting('admin_password_hash', passwordHash);
      const action = passwordMissing ? 'admin.initialized' : 'admin.username_initialized';
      const summary = passwordMissing
        ? 'Initialized the administrator account and password'
        : 'Initialized the administrator account name';
      store.appendAudit({
        actor: 'system',
        action,
        summary,
      });
    });
  }

  // Browser cookies can outlive a restored database snapshot. Treat sessions as
  // process-local state so a restart or restore cannot revive a revoked cookie.
  store.deleteAllSessions();

  return new AdminAuth({
    store,
    username,
    sessionTtlSeconds,
    secureCookies,
    maxLoginAttempts,
    loginWindowSeconds,
  });
}

export class AdminAuth {
  constructor({
    store,
    username = 'admin',
    sessionTtlSeconds,
    secureCookies,
    maxLoginAttempts,
    loginWindowSeconds,
  }) {
    this.store = store;
    this.username = usernameValue(username);
    this.sessionTtlSeconds = sessionTtlSeconds;
    this.secureCookies = secureCookies;
    this.maxLoginAttempts = maxLoginAttempts;
    this.loginWindowSeconds = loginWindowSeconds;
    this.attempts = new Map();
    this.passwordChangeTail = Promise.resolve();
  }

  #attemptState(clientKey) {
    const now = Math.floor(Date.now() / 1000);
    if (this.attempts.size >= 1024) {
      for (const [key, state] of this.attempts) {
        if (state.resetAt <= now) this.attempts.delete(key);
      }
      while (this.attempts.size >= 1024) {
        this.attempts.delete(this.attempts.keys().next().value);
      }
    }
    const current = this.attempts.get(clientKey);
    if (!current || current.resetAt <= now) {
      const fresh = { count: 0, resetAt: now + this.loginWindowSeconds };
      this.attempts.set(clientKey, fresh);
      return fresh;
    }
    return current;
  }

  async login(username, password, clientKey = 'unknown') {
    const state = this.#attemptState(clientKey);
    const now = Math.floor(Date.now() / 1000);
    if (state.count >= this.maxLoginAttempts) {
      throw new AdminAuthError(
        'too many login attempts',
        429,
        'ADMIN_LOGIN_RATE_LIMITED',
        Math.max(1, state.resetAt - now),
      );
    }

    const usernameMatches = constantTimeTextEqual(
      typeof username === 'string' ? username : '',
      this.username,
    );
    const passwordMatches = await verifyPassword(password, this.store.getSetting('admin_password_hash'));
    const valid = usernameMatches && passwordMatches;
    if (!valid) {
      state.count += 1;
      throw new AdminAuthError('invalid administrator credentials');
    }
    this.attempts.delete(clientKey);
    this.store.purgeSessions(now);

    const sessionToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(24).toString('base64url');
    const expiresAt = now + this.sessionTtlSeconds;
    this.store.createSession(sha256(sessionToken), expiresAt);
    this.store.appendAudit({
      actor: this.username,
      action: 'admin.login',
      summary: 'Administrator signed in',
    });

    return {
      username: this.username,
      csrfToken,
      expiresAt,
      cookies: [
        cookie(SESSION_COOKIE, sessionToken, {
          maxAge: this.sessionTtlSeconds,
          secure: this.secureCookies,
          httpOnly: true,
        }),
        cookie(CSRF_COOKIE, csrfToken, {
          maxAge: this.sessionTtlSeconds,
          secure: this.secureCookies,
        }),
      ],
    };
  }

  authenticate(request) {
    const cookies = parseCookies(request);
    const sessionToken = cookies[SESSION_COOKIE];
    if (!sessionToken) return null;
    const sessionHash = sha256(sessionToken);
    const session = this.store.getSession(sessionHash);
    const now = Math.floor(Date.now() / 1000);
    if (!session || session.expiresAt <= now) {
      if (session) this.store.deleteSession(sessionHash);
      return null;
    }
    return {
      actor: this.username,
      username: this.username,
      sessionHash,
      csrfToken: cookies[CSRF_COOKIE] || '',
      expiresAt: session.expiresAt,
    };
  }

  requireSession(request) {
    const session = this.authenticate(request);
    if (!session) throw new AdminAuthError('administrator authentication required');
    return session;
  }

  requireCsrf(request, session) {
    const header = request.headers.get('x-csrf-token');
    if (!header || !session.csrfToken || !constantTimeTextEqual(header, session.csrfToken)) {
      throw new AdminAuthError('invalid CSRF token', 403, 'ADMIN_CSRF_INVALID');
    }
  }

  revokeSession(session) {
    if (session?.sessionHash) this.store.deleteSession(session.sessionHash);
  }

  revokeAllSessions() {
    this.store.deleteAllSessions();
  }

  #requireActiveSession(session) {
    const stored = session?.sessionHash ? this.store.getSession(session.sessionHash) : null;
    const now = Math.floor(Date.now() / 1000);
    if (!stored || stored.expiresAt <= now) {
      if (stored) this.store.deleteSession(session.sessionHash);
      throw new AdminAuthError('administrator authentication required');
    }
  }

  logout(session) {
    this.revokeSession(session);
    this.store.appendAudit({
      actor: this.username,
      action: 'admin.logout',
      summary: 'Administrator signed out',
    });
    // The revoked cookie is harmless and the next login overwrites it. Returning
    // a delayed deletion cookie could erase a newer session opened in another tab.
    return [];
  }

  async changePassword(currentPassword, nextPassword, session, { afterSessionRevocation = null } = {}) {
    const previous = this.passwordChangeTail;
    let release;
    this.passwordChangeTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      this.#requireActiveSession(session);
      const valid = await verifyPassword(currentPassword, this.store.getSetting('admin_password_hash'));
      if (!valid) throw new AdminAuthError('current password is incorrect', 403, 'ADMIN_PASSWORD_INCORRECT');
      const nextHash = await hashPassword(nextPassword);
      this.#requireActiveSession(session);
      this.store.transaction(() => {
        this.store.setSetting('admin_password_hash', nextHash);
        this.revokeAllSessions();
        this.store.appendAudit({
          actor: this.username,
          action: 'admin.password_changed',
          summary: 'Changed the administrator password and revoked all sessions',
        });
      });
      if (typeof afterSessionRevocation === 'function') await afterSessionRevocation();
      return this.logout(session);
    } finally {
      release();
    }
  }
}
