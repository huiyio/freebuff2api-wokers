import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AccountRuntime,
  AccountService,
  AccountServiceError,
  importLegacyCredentials,
} from '../account-manager.js';
import { AccountStore } from '../account-store.js';
import { createCredentialVault } from '../credential-vault.js';

async function managerFixture(records = []) {
  const directory = await mkdtemp(join(tmpdir(), 'freebuff-account-manager-'));
  const store = new AccountStore({
    databasePath: join(directory, 'accounts.sqlite'),
    vault: createCredentialVault('61'.repeat(32)),
  });
  importLegacyCredentials(store, records, { requireProxy: true });
  const runtime = new AccountRuntime({
    store,
    requireProxy: true,
    protectedHosts: new Set(['www.codebuff.com']),
    connectTimeoutMs: 100,
    retireMs: 0,
  });
  runtime.initialize();
  const invalidations = [];
  runtime.setAccountStateInvalidator((tokens, activeTokenString) => {
    invalidations.push({ tokens: [...tokens], activeTokenString });
  });
  const service = new AccountService({ store, runtime, requireProxy: true, connectTimeoutMs: 100 });
  return {
    store,
    runtime,
    service,
    invalidations,
    async close() {
      await runtime.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('imports proxy-less legacy accounts disabled and hot reloads validated routes', async () => {
  const fixture = await managerFixture([{
    source: 'legacy.json:one',
    name: 'Legacy',
    email: 'legacy@example.com',
    authToken: 'legacy-account-token-12345',
    token: 'legacy-account-token-12345',
    proxyUrl: null,
    proxyRequired: false,
    enabled: true,
  }]);
  try {
    let [account] = fixture.service.list();
    assert.equal(account.enabled, false);
    assert.equal(account.proxyRequired, true);
    assert.equal(fixture.runtime.tokenString, '');

    account = await fixture.service.update(account.id, {
      proxyUrl: 'http://user:password@127.0.0.1:9',
      enabled: true,
    });
    assert.equal(account.enabled, true);
    assert.equal(fixture.runtime.tokenString, 'legacy-account-token-12345');
    assert.deepEqual(fixture.invalidations.at(-1), {
      tokens: ['legacy-account-token-12345'],
      activeTokenString: 'legacy-account-token-12345',
    });
    assert.equal(fixture.service.list([{ account: 1, alive: false, state: 'banned' }])[0].upstreamState, 'banned');

    await assert.rejects(
      globalThis.fetch('https://www.codebuff.com/api/session', {
        headers: { authorization: 'Bearer unknown-account-token' },
      }),
      /no account proxy route/,
    );

    await fixture.service.update(account.id, { enabled: false });
    assert.equal(fixture.runtime.tokenString, '');
    assert.deepEqual(fixture.invalidations.at(-1), {
      tokens: ['legacy-account-token-12345'],
      activeTokenString: '',
    });
    await fixture.service.delete(account.id);
    assert.equal(importLegacyCredentials(fixture.store, [{
      source: 'legacy.json:one',
      name: 'Legacy',
      authToken: 'legacy-account-token-12345',
      token: 'legacy-account-token-12345',
      proxyUrl: null,
      proxyRequired: false,
      enabled: true,
    }], { requireProxy: true }).imported, 0);
    assert.equal(fixture.store.countAccounts(), 0);
  } finally {
    await fixture.close();
  }
});

test('does not reimport deleted legacy accounts after the database is reopened', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'freebuff-legacy-restart-'));
  const databasePath = join(directory, 'accounts.sqlite');
  const masterKey = '62'.repeat(32);
  const records = [{
    source: 'legacy.json:restart',
    name: 'Restart Legacy',
    email: 'restart@example.com',
    authToken: 'restart-legacy-token-12345',
    token: 'restart-legacy-token-12345',
    proxyUrl: 'http://test-user:test-password@127.0.0.1:8080',
    proxyRequired: true,
    enabled: true,
  }];
  let store = new AccountStore({
    databasePath,
    vault: createCredentialVault(masterKey),
  });

  try {
    assert.deepEqual(
      importLegacyCredentials(store, records, { requireProxy: true }),
      { imported: 1, disabled: 0 },
    );
    const [imported] = store.listAccounts();
    assert.equal(store.deleteAccount(imported.id), true);
    assert.equal(store.countAccounts(), 0);
    assert.equal(store.getSetting('legacy_import_completed'), 'true');
    store.close();
    store = null;

    store = new AccountStore({
      databasePath,
      vault: createCredentialVault(masterKey),
    });
    assert.deepEqual(
      importLegacyCredentials(store, records, { requireProxy: true }),
      { imported: 0, disabled: 0 },
    );
    assert.equal(store.countAccounts(), 0);
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('pins token metadata with the proxy generation during an account update', async () => {
  const fixture = await managerFixture();
  try {
    const created = await fixture.service.create({
      name: 'Snapshot account',
      authToken: 'snapshot-token-before-12345',
      proxyUrl: 'http://user:password@127.0.0.1:8080',
      proxyRequired: true,
      enabled: true,
    });
    const firstGeneration = fixture.runtime.snapshot.generation;

    await fixture.runtime.runWithCurrentProxySnapshot(async (snapshot) => {
      assert.equal(snapshot.generation, firstGeneration);
      assert.equal(snapshot.tokenString, 'snapshot-token-before-12345');
      await fixture.service.update(created.id, {
        authToken: 'snapshot-token-after-12345',
      });
      assert.equal(snapshot.generation, firstGeneration);
      assert.equal(snapshot.tokenString, 'snapshot-token-before-12345');
      assert.equal(fixture.runtime.tokenString, 'snapshot-token-after-12345');
    });

    await fixture.runtime.runWithCurrentProxySnapshot((snapshot) => {
      assert.ok(snapshot.generation > firstGeneration);
      assert.equal(snapshot.tokenString, 'snapshot-token-after-12345');
    });
  } finally {
    await fixture.close();
  }
});

test('maps health by the captured account id instead of mutable array position', async () => {
  const fixture = await managerFixture();
  try {
    const first = await fixture.service.create({
      name: 'First',
      authToken: 'health-map-first-token-12345',
      proxyUrl: 'http://user:password@127.0.0.1:8080',
      proxyRequired: true,
      enabled: true,
    });
    const second = await fixture.service.create({
      name: 'Second',
      authToken: 'health-map-second-token-12345',
      proxyUrl: 'http://user:password@127.0.0.1:8081',
      proxyRequired: true,
      enabled: true,
    });
    const mapped = fixture.runtime.mapHealth([
      { accountId: second.id, alive: false, state: 'banned' },
      { accountId: first.id, alive: true, state: 'ok' },
    ]);
    assert.equal(mapped.get(first.id).state, 'ok');
    assert.equal(mapped.get(second.id).state, 'banned');
    const stale = fixture.runtime.mapHealth([
      { accountId: first.id, accountGeneration: fixture.runtime.snapshot.generation - 1, alive: false, state: 'banned' },
    ]);
    assert.equal(stale.has(first.id), false);
  } finally {
    await fixture.close();
  }
});

test('rejects duplicate tokens and records a sanitized fixed-target proxy test', async () => {
  const fixture = await managerFixture();
  try {
    const created = await fixture.service.create({
      name: 'Account A',
      authToken: 'managed-account-token-12345',
      proxyUrl: 'http://user:password@127.0.0.1:8080',
      proxyRequired: true,
      enabled: true,
    });
    await assert.rejects(fixture.service.create({
      name: 'Duplicate',
      authToken: 'managed-account-token-12345:other-user',
      proxyUrl: 'http://127.0.0.1:8081',
      proxyRequired: true,
      enabled: true,
    }), (error) => error instanceof AccountServiceError && error.status === 409);

    const tested = await fixture.service.testProxy(created.id, 'admin', {
      testUrl: 'https://fixed.test/',
      fetchImpl: async (url, init) => {
        assert.equal(url, 'https://fixed.test/');
        assert.ok(init.dispatcher);
        return new Response(null, { status: 204 });
      },
    });
    assert.equal(tested.result.ok, true);
    assert.equal(tested.account.lastProxyStatus, 'ok');
    assert.doesNotMatch(JSON.stringify(fixture.store.listAudit()), /password|managed-account-token/);
  } finally {
    await fixture.close();
  }
});
