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
