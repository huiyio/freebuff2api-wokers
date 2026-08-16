import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AccountStore } from '../account-store.js';
import { createCredentialVault, CredentialVaultError } from '../credential-vault.js';

async function withStore(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'freebuff-account-store-'));
  const databasePath = join(directory, 'accounts.sqlite');
  const vault = createCredentialVault('31'.repeat(32));
  const store = new AccountStore({ databasePath, vault });
  try {
    await operation({ directory, databasePath, store });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('encrypts account secrets, masks API output, and rejects duplicate tokens', async () => {
  await withStore(async ({ directory, store }) => {
    const created = store.createAccount({
      name: 'Primary',
      email: 'primary@example.com',
      authToken: 'account-secret-token-12345:user-id',
      token: 'account-secret-token-12345',
      proxyUrl: 'socks5://proxy-user:proxy-password@proxy.example.com:1080',
      proxyRequired: true,
      enabled: true,
    });

    assert.equal(created.authToken, 'account-secret-token-12345:user-id');
    assert.equal(created.proxyUrl, 'socks5://proxy-user:proxy-password@proxy.example.com:1080');
    const publicAccount = store.getAccount(created.id);
    assert.equal(publicAccount.authToken, undefined);
    assert.equal(publicAccount.proxyUrl, undefined);
    assert.equal(publicAccount.proxyUrlMasked, 'socks5://***@proxy.example.com:1080');

    const apiKey = 'api-key-secret-that-must-stay-encrypted';
    store.setSecretSetting('api_key_cipher', apiKey, 'settings:api_key');
    assert.equal(store.getSecretSetting('api_key_cipher', 'settings:api_key'), apiKey);

    assert.throws(() => store.createAccount({
      name: 'Duplicate',
      authToken: 'account-secret-token-12345:another-user',
      token: 'account-secret-token-12345',
      proxyUrl: 'http://127.0.0.1:8080',
      proxyRequired: true,
      enabled: true,
    }), /UNIQUE constraint failed/);

    const files = await readdir(directory);
    const raw = Buffer.concat(await Promise.all(files.map((file) => readFile(join(directory, file))))).toString('latin1');
    assert.doesNotMatch(raw, /account-secret-token|proxy-password|api-key-secret/);
  });
});

test('verifies the encryption key and persists sessions and audit records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freebuff-account-store-key-'));
  const databasePath = join(directory, 'accounts.sqlite');
  const first = new AccountStore({
    databasePath,
    vault: createCredentialVault('41'.repeat(32)),
  });
  first.createSession('session-hash', 2000000000);
  first.appendAudit({ action: 'test.action', summary: 'safe summary' });
  assert.equal(first.getSession('session-hash').expiresAt, 2000000000);
  assert.equal(first.listAudit()[0].action, 'test.action');
  first.close();

  assert.throws(() => new AccountStore({
    databasePath,
    vault: createCredentialVault('42'.repeat(32)),
  }), (error) => error instanceof CredentialVaultError);

  const reopened = new AccountStore({
    databasePath,
    vault: createCredentialVault('41'.repeat(32)),
  });
  reopened.setSetting('post_key_failure_write', 'ok');
  assert.equal(reopened.getSetting('post_key_failure_write'), 'ok');
  reopened.close();
  await rm(directory, { recursive: true, force: true });
});

test('rejects non-canonical master keys and never replaces a missing vault sentinel', async () => {
  const canonicalBase64Url = Buffer.alloc(32, 0x55).toString('base64url');
  assert.doesNotThrow(() => createCredentialVault(canonicalBase64Url));
  assert.throws(
    () => createCredentialVault(`${canonicalBase64Url.slice(0, -1)}.`),
    (error) => error instanceof CredentialVaultError,
  );

  const directory = await mkdtemp(join(tmpdir(), 'freebuff-account-store-sentinel-'));
  const databasePath = join(directory, 'accounts.sqlite');
  const original = new AccountStore({
    databasePath,
    vault: createCredentialVault('51'.repeat(32)),
  });
  original.createAccount({
    name: 'Sentinel test',
    authToken: 'sentinel-test-token-12345',
    token: 'sentinel-test-token-12345',
    proxyUrl: null,
    proxyRequired: false,
    enabled: false,
  });
  original.close();

  const raw = new DatabaseSync(databasePath);
  raw.prepare("DELETE FROM settings WHERE key = 'vault_check'").run();
  raw.close();

  assert.throws(() => new AccountStore({
    databasePath,
    vault: createCredentialVault('52'.repeat(32)),
  }), /vault verification record is missing/);

  const verify = new DatabaseSync(databasePath);
  assert.equal(verify.prepare("SELECT value FROM settings WHERE key = 'vault_check'").get(), undefined);
  verify.close();
  await rm(directory, { recursive: true, force: true });
});

test('encrypts API key settings and restores them after reopening the database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freebuff-account-store-api-key-'));
  const databasePath = join(directory, 'accounts.sqlite');
  const apiKey = 'persisted-account-store-api-key-123456789';
  const first = new AccountStore({
    databasePath,
    vault: createCredentialVault('61'.repeat(32)),
  });

  try {
    first.setSecretSetting('api_key_cipher', apiKey, 'settings:api_key');
    assert.equal(first.getSecretSetting('api_key_cipher', 'settings:api_key'), apiKey);
    const files = await readdir(directory);
    const raw = Buffer.concat(await Promise.all(
      files.map((file) => readFile(join(directory, file))),
    )).toString('latin1');
    assert.doesNotMatch(raw, /persisted-account-store-api-key-123456789/);
  } finally {
    first.close();
  }

  const reopened = new AccountStore({
    databasePath,
    vault: createCredentialVault('61'.repeat(32)),
  });
  try {
    assert.equal(reopened.getSecretSetting('api_key_cipher', 'settings:api_key'), apiKey);
  } finally {
    reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('migrates a v1 account database to v2 automatic recovery fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freebuff-account-store-migration-'));
  const databasePath = join(directory, 'accounts.sqlite');
  const v1Sql = await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8');
  const vault = createCredentialVault('71'.repeat(32));
  const accountId = 'legacy-account-id';
  const authToken = 'legacy-account-token-12345:legacy-user';
  const proxyUrl = 'socks5://legacy-user:legacy-password@127.0.0.1:1080';
  const raw = new DatabaseSync(databasePath);
  raw.exec(v1Sql);
  raw.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    'vault_check',
    vault.encrypt('freebuff-account-store-v1', 'settings:vault_check'),
    '2026-08-16T00:00:00.000Z',
  );
  raw.prepare(`
    INSERT INTO accounts (
      id, name, email, auth_token_cipher, token_fingerprint, proxy_url_cipher,
      proxy_required, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    accountId,
    'Legacy encrypted account',
    'legacy@example.com',
    vault.encrypt(authToken, `account:${accountId}:authToken`),
    vault.fingerprint('freebuff-token', 'legacy-account-token-12345'),
    vault.encrypt(proxyUrl, `account:${accountId}:proxyUrl`),
    1,
    1,
    '2026-08-16T00:00:00.000Z',
    '2026-08-16T00:00:00.000Z',
  );
  raw.close();

  const store = new AccountStore({
    databasePath,
    vault,
  });
  try {
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
    const columns = store.db.prepare("PRAGMA table_info('accounts')").all().map((column) => column.name);
    for (const column of [
      'auto_pause_reason',
      'auto_paused_at',
      'next_recovery_probe_at',
      'last_recovery_probe_at',
      'last_recovery_state',
      'recovery_attempts',
      'state_revision',
    ]) {
      assert.ok(columns.includes(column), `missing migrated column ${column}`);
    }
    const restored = store.getAccount(accountId, { includeSecrets: true });
    assert.equal(restored.authToken, authToken);
    assert.equal(restored.proxyUrl, proxyUrl);
    assert.equal(restored.effectiveEnabled, true);
    assert.equal(restored.autoPaused, false);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('persists rate-limit pauses, leases one recovery probe, and resumes only with the claimed revision', async () => {
  await withStore(async ({ store }) => {
    const created = store.createAccount({
      name: 'Recoverable account',
      authToken: 'recoverable-account-token-12345',
      token: 'recoverable-account-token-12345',
      proxyUrl: null,
      proxyRequired: false,
      enabled: true,
    });
    const pausedAt = '2026-08-16T00:00:00.000Z';
    const firstProbeAt = '2026-08-16T00:05:00.000Z';
    const paused = store.pauseAccountForRateLimit(created.id, {
      observedAt: pausedAt,
      nextProbeAt: firstProbeAt,
      message: 'upstream returned 429',
    });

    assert.equal(paused.changed, true);
    assert.equal(paused.account.enabled, true);
    assert.equal(paused.account.effectiveEnabled, false);
    assert.equal(paused.account.autoPaused, true);
    assert.equal(paused.account.autoPauseReason, 'rate_limited');
    assert.equal(paused.account.nextRecoveryProbeAt, firstProbeAt);
    const duplicatePause = store.pauseAccountForRateLimit(created.id, {
      observedAt: '2026-08-16T00:00:01.000Z',
      nextProbeAt: '2026-08-16T00:10:00.000Z',
    });
    assert.equal(duplicatePause.changed, false);
    assert.equal(duplicatePause.account.stateRevision, paused.account.stateRevision);
    assert.equal(duplicatePause.account.nextRecoveryProbeAt, firstProbeAt);
    assert.equal(store.claimDueRecoveryProbes('2026-08-16T00:04:59.000Z', 'monitor-a').length, 0);

    const [firstClaim] = store.claimDueRecoveryProbes(firstProbeAt, 'monitor-a', 60000);
    assert.ok(firstClaim);
    assert.equal(firstClaim.authToken, 'recoverable-account-token-12345');
    assert.equal(firstClaim.recoveryAttempts, 1);
    assert.equal(firstClaim.lastRecoveryState, 'probing');
    assert.equal(store.claimDueRecoveryProbes(firstProbeAt, 'monitor-b', 60000).length, 0);

    const stale = store.keepRecoveryPaused(created.id, {
      owner: 'monitor-a',
      revision: firstClaim.stateRevision - 1,
      state: 'rate_limited',
      nextProbeAt: '2026-08-16T00:10:00.000Z',
    });
    assert.equal(stale.changed, false);
    assert.equal(stale.account.autoPaused, true);

    const secondProbeAt = '2026-08-16T00:10:00.000Z';
    const kept = store.keepRecoveryPaused(created.id, {
      owner: 'monitor-a',
      revision: firstClaim.stateRevision,
      state: 'rate_limited',
      nextProbeAt: secondProbeAt,
      message: 'still limited',
    });
    assert.equal(kept.changed, true);
    assert.equal(kept.account.nextRecoveryProbeAt, secondProbeAt);
    assert.equal(kept.account.lastRecoveryState, 'rate_limited');

    const [secondClaim] = store.claimDueRecoveryProbes(secondProbeAt, 'monitor-a', 60000);
    assert.ok(secondClaim);
    const resumed = store.completeRecoveryProbe(created.id, {
      owner: 'monitor-a',
      revision: secondClaim.stateRevision,
      state: 'ok',
      message: 'read-only recovery probe passed',
    });
    assert.equal(resumed.changed, true);
    assert.equal(resumed.account.enabled, true);
    assert.equal(resumed.account.effectiveEnabled, true);
    assert.equal(resumed.account.autoPaused, false);
    assert.equal(resumed.account.autoPauseReason, null);
    assert.equal(resumed.account.nextRecoveryProbeAt, null);
  });
});

test('manual state changes invalidate a recovery claim and account edits preserve or clear automatic pauses deliberately', async () => {
  await withStore(async ({ store }) => {
    const token = 'replacement-account-token-12345';
    const created = store.createAccount({
      name: 'Replacement account',
      authToken: token,
      token,
      proxyUrl: null,
      proxyRequired: false,
      enabled: true,
    });
    store.pauseAccountForRateLimit(created.id, {
      observedAt: '2026-08-16T01:00:00.000Z',
      nextProbeAt: '2026-08-16T01:05:00.000Z',
    });

    const paused = store.getAccount(created.id, { includeSecrets: true });
    const renamed = store.replaceAccount({
      id: paused.id,
      name: 'Renamed account',
      email: paused.email,
      authToken: paused.authToken,
      token,
      proxyUrl: paused.proxyUrl,
      proxyRequired: paused.proxyRequired,
      enabled: paused.enabled,
      createdAt: paused.createdAt,
      updatedAt: '2026-08-16T01:01:00.000Z',
    });
    assert.equal(renamed.autoPauseReason, 'rate_limited');
    assert.equal(renamed.effectiveEnabled, false);
    assert.ok(renamed.stateRevision > paused.stateRevision);

    const [claim] = store.claimDueRecoveryProbes('2026-08-16T01:05:00.000Z', 'monitor-a', 60000);
    assert.ok(claim);
    const manuallyDisabled = store.replaceAccount({
      id: claim.id,
      name: claim.name,
      email: claim.email,
      authToken: claim.authToken,
      token,
      proxyUrl: claim.proxyUrl,
      proxyRequired: claim.proxyRequired,
      enabled: false,
      createdAt: claim.createdAt,
      updatedAt: '2026-08-16T01:05:01.000Z',
    });
    assert.equal(manuallyDisabled.enabled, false);
    assert.equal(manuallyDisabled.autoPaused, false);
    assert.equal(manuallyDisabled.effectiveEnabled, false);

    const staleCompletion = store.completeRecoveryProbe(claim.id, {
      owner: 'monitor-a',
      revision: claim.stateRevision,
      state: 'ok',
    });
    assert.equal(staleCompletion.changed, false);
    assert.equal(staleCompletion.account.enabled, false);
  });
});
