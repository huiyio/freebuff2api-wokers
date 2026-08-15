import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AccountStore } from '../account-store.js';
import { AdminAuthError, initializeAdminAuth } from '../admin-auth.js';
import { createCredentialVault } from '../credential-vault.js';

async function authFixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'freebuff-admin-auth-'));
  const store = new AccountStore({
    databasePath: join(directory, 'auth.sqlite'),
    vault: createCredentialVault('51'.repeat(32)),
  });
  const auth = await initializeAdminAuth({
    store,
    initialUsername: 'initial-admin',
    initialPassword: 'initial-admin-password',
    sessionTtlSeconds: 3600,
    secureCookies: false,
    ...options,
  });
  return {
    store,
    auth,
    async close() {
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('issues an HttpOnly session, enforces CSRF, and revokes logout', async () => {
  const fixture = await authFixture();
  try {
    const login = await fixture.auth.login('initial-admin', 'initial-admin-password', '127.0.0.1');
    assert.equal(login.cookies.length, 2);
    assert.match(login.cookies[0], /HttpOnly/);
    assert.match(login.cookies[0], /SameSite=Strict/);
    const cookieHeader = login.cookies.map((value) => value.split(';', 1)[0]).join('; ');
    const request = new Request('http://local/admin/api/accounts', {
      headers: { cookie: cookieHeader, 'x-csrf-token': login.csrfToken },
    });
    const session = fixture.auth.requireSession(request);
    fixture.auth.requireCsrf(request, session);
    assert.throws(
      () => fixture.auth.requireCsrf(new Request(request.url, { headers: { cookie: cookieHeader } }), session),
      (error) => error instanceof AdminAuthError && error.code === 'ADMIN_CSRF_INVALID',
    );
    fixture.auth.logout(session);
    assert.equal(fixture.auth.authenticate(request), null);
  } finally {
    await fixture.close();
  }
});

test('rate limits failed logins', async () => {
  const fixture = await authFixture({ maxLoginAttempts: 2, loginWindowSeconds: 60 });
  try {
    await assert.rejects(fixture.auth.login('initial-admin', 'wrong-password-value', 'client-a'), /invalid administrator credentials/);
    await assert.rejects(fixture.auth.login('initial-admin', 'wrong-password-value', 'client-a'), /invalid administrator credentials/);
    await assert.rejects(
      fixture.auth.login('initial-admin', 'initial-admin-password', 'client-a'),
      (error) => error instanceof AdminAuthError && error.status === 429,
    );
  } finally {
    await fixture.close();
  }
});

test('persists a custom administrator username and ignores later bootstrap changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freebuff-admin-username-persist-'));
  const databasePath = join(directory, 'auth.sqlite');
  const vaultKey = '52'.repeat(32);
  const password = 'custom-admin-password';
  let store = null;

  try {
    store = new AccountStore({ databasePath, vault: createCredentialVault(vaultKey) });
    const auth = await initializeAdminAuth({
      store,
      initialUsername: 'ops-admin',
      initialPassword: password,
    });
    assert.equal(store.getSetting('admin_username'), 'ops-admin');
    const login = await auth.login('ops-admin', password, 'custom-user');
    assert.equal(login.username, 'ops-admin');
    await assert.rejects(
      auth.login('admin', password, 'wrong-user'),
      (error) => error instanceof AdminAuthError && error.code === 'ADMIN_UNAUTHORIZED',
    );
    await assert.rejects(auth.login(' ops-admin ', password, 'padded-user'), /invalid administrator credentials/);
    store.close();
    store = new AccountStore({ databasePath, vault: createCredentialVault(vaultKey) });
    const restarted = await initializeAdminAuth({
      store,
      initialUsername: 'changed-by-env',
      initialPassword: 'another-bootstrap-password',
    });
    assert.equal(store.getSetting('admin_username'), 'ops-admin');
    await assert.rejects(restarted.login('changed-by-env', password, 'changed-user'), /invalid administrator credentials/);
    const accepted = await restarted.login('ops-admin', password, 'restarted-user');
    assert.equal(accepted.username, 'ops-admin');
  } finally {
    try { store?.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});

test('fills in the administrator username for a legacy database that only has a password hash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freebuff-admin-username-migrate-'));
  const databasePath = join(directory, 'auth.sqlite');
  const vaultKey = '53'.repeat(32);
  const password = 'legacy-admin-password';
  let store = null;

  try {
    store = new AccountStore({ databasePath, vault: createCredentialVault(vaultKey) });
    await initializeAdminAuth({
      store,
      initialUsername: 'temporary-admin',
      initialPassword: password,
    });
    store.db.prepare('DELETE FROM settings WHERE key = ?').run('admin_username');
    store.close();
    store = new AccountStore({ databasePath, vault: createCredentialVault(vaultKey) });
    const migrated = await initializeAdminAuth({
      store,
      initialUsername: 'migrated-admin',
    });
    assert.equal(store.getSetting('admin_username'), 'migrated-admin');
    const login = await migrated.login('migrated-admin', password, 'migration-user');
    assert.equal(login.username, 'migrated-admin');
  } finally {
    try { store?.close(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects invalid first-run administrator credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freebuff-admin-username-invalid-'));
  const store = new AccountStore({
    databasePath: join(directory, 'auth.sqlite'),
    vault: createCredentialVault('54'.repeat(32)),
  });
  try {
    await assert.rejects(
      initializeAdminAuth({ store, initialUsername: 'admin' }),
      (error) => error instanceof AdminAuthError && error.code === 'ADMIN_PASSWORD_REQUIRED',
    );
    for (const invalidPassword of ['too-short', 'x'.repeat(257)]) {
      await assert.rejects(
        initializeAdminAuth({
          store,
          initialUsername: 'admin',
          initialPassword: invalidPassword,
        }),
        (error) => error instanceof AdminAuthError && error.code === 'ADMIN_PASSWORD_INVALID',
      );
    }
    await assert.rejects(
      initializeAdminAuth({
        store,
        initialUsername: ' padded-admin ',
        initialPassword: 'valid-admin-password',
      }),
      (error) => error instanceof AdminAuthError && error.code === 'ADMIN_USERNAME_INVALID',
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('revokes sessions and changes the password before an external authorization cleanup hook completes', async () => {
  const fixture = await authFixture();
  let releaseCleanup;
  let cleanupStarted;
  const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
  const cleanupStartedGate = new Promise((resolve) => { cleanupStarted = resolve; });
  try {
    const login = await fixture.auth.login('initial-admin', 'initial-admin-password', 'cleanup-test');
    const cookieHeader = login.cookies.map((value) => value.split(';', 1)[0]).join('; ');
    const request = new Request('http://local/admin/api/session', { headers: { cookie: cookieHeader } });
    const changing = fixture.auth.changePassword(
      'initial-admin-password',
      'next-admin-password',
      fixture.auth.requireSession(request),
      {
        afterSessionRevocation: async () => {
          cleanupStarted();
          await cleanupGate;
        },
      },
    );
    await cleanupStartedGate;
    assert.equal(fixture.auth.authenticate(request), null);
    await assert.rejects(
      fixture.auth.login('initial-admin', 'initial-admin-password', 'old-password'),
      (error) => error instanceof AdminAuthError && error.code === 'ADMIN_UNAUTHORIZED',
    );
    const newLogin = await fixture.auth.login('initial-admin', 'next-admin-password', 'new-password');
    assert.equal(newLogin.username, 'initial-admin');
    releaseCleanup();
    await changing;
  } finally {
    releaseCleanup?.();
    await fixture.close();
  }
});

test('serializes concurrent password changes and rejects a stale authenticated session', async () => {
  const fixture = await authFixture();
  try {
    const login = await fixture.auth.login('initial-admin', 'initial-admin-password', 'password-race');
    const cookieHeader = login.cookies.map((value) => value.split(';', 1)[0]).join('; ');
    const request = new Request('http://local/admin/api/password', { headers: { cookie: cookieHeader } });
    const sessionForFirst = fixture.auth.requireSession(request);
    const sessionForSecond = fixture.auth.requireSession(request);
    const first = fixture.auth.changePassword('initial-admin-password', 'first-next-password', sessionForFirst);
    const second = fixture.auth.changePassword('initial-admin-password', 'second-next-password', sessionForSecond);
    const [firstResult, secondResult] = await Promise.allSettled([first, second]);
    assert.equal(firstResult.status, 'fulfilled');
    assert.equal(secondResult.status, 'rejected');
    assert.equal(secondResult.reason instanceof AdminAuthError, true);
    assert.equal(secondResult.reason.code, 'ADMIN_UNAUTHORIZED');
    const accepted = await fixture.auth.login('initial-admin', 'first-next-password', 'winning-password');
    assert.equal(accepted.username, 'initial-admin');
    await assert.rejects(
      fixture.auth.login('initial-admin', 'second-next-password', 'losing-password'),
      (error) => error instanceof AdminAuthError && error.code === 'ADMIN_UNAUTHORIZED',
    );
  } finally {
    await fixture.close();
  }
});
