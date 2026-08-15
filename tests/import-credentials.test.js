import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AccountStore } from '../account-store.js';
import { createCredentialVault } from '../credential-vault.js';

const projectDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');

function runImporter(env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['import-credentials.js'], {
      cwd: projectDirectory,
      windowsHide: true,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test('one-off importer stores legacy credentials once without printing secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freebuff-import-command-'));
  const credentialsDirectory = join(directory, 'credentials');
  const databasePath = join(directory, 'accounts.sqlite');
  const masterKey = '73'.repeat(32);
  const authToken = 'one-off-import-token-12345';
  const proxyUrl = 'socks5://import-user:import-password@127.0.0.1:1080';
  await mkdir(credentialsDirectory);
  await writeFile(join(credentialsDirectory, 'legacy.json'), JSON.stringify({
    name: 'Imported account',
    authToken,
    proxyUrl,
    proxyRequired: true,
    enabled: true,
  }));

  const env = {
    ACCOUNT_DB_PATH: databasePath,
    ACCOUNT_STORE_KEY: masterKey,
    CREDENTIALS_DIR: credentialsDirectory,
    REQUIRE_ACCOUNT_PROXY: 'true',
  };

  try {
    const first = await runImporter(env);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /completed: 1 accounts/);
    assert.doesNotMatch(`${first.stdout}${first.stderr}`, /one-off-import-token|import-password/);

    const store = new AccountStore({
      databasePath,
      vault: createCredentialVault(masterKey),
    });
    try {
      assert.equal(store.countAccounts(), 1);
      assert.equal(store.listAccounts({ includeSecrets: true })[0].authToken, authToken);
    } finally {
      store.close();
    }

    const second = await runImporter(env);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /skipped: database already initialized \(1 accounts\)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
