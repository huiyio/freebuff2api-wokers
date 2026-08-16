import {
  AccountProxyConfigError,
  createAccountRoute,
  installReloadableAccountProxyFetch,
  normalizeTokenEntry,
  probeAccountProxyStages,
  probeAccountConnection,
  probeAccountRecovery,
} from './account-proxy.js';
import {
  AdminModelTestError,
  listTestModels,
  testAccountModel,
} from './admin-model-tester.js';

const DEFAULT_RECOVERY_INTERVAL_MS = 5 * 60 * 1000;

function recoveryProbeAt(now, retryAfterMs = null) {
  const hintedDelay = Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? Math.min(Math.round(retryAfterMs), 6 * 60 * 60 * 1000)
    : 0;
  return new Date(now.getTime() + Math.max(DEFAULT_RECOVERY_INTERVAL_MS, hintedDelay)).toISOString();
}

function recoveryResultMessage(result, token) {
  const text = String(result?.message || 'recovery probe did not return a result');
  const secret = String(token || '');
  return (secret ? text.replaceAll(secret, '[redacted]') : text).slice(0, 240);
}

export class AccountServiceError extends Error {
  constructor(message, status = 400, code = 'ACCOUNT_INVALID') {
    super(message);
    this.name = 'AccountServiceError';
    this.status = status;
    this.code = code;
  }
}

function stringField(value, name, max, { required = false } = {}) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  if (required && !text) throw new AccountServiceError(`${name} is required`);
  if (text.length > max) throw new AccountServiceError(`${name} is too long`);
  if (/[\r\n\0]/.test(text)) throw new AccountServiceError(`${name} contains invalid characters`);
  return text;
}

function booleanField(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new AccountServiceError(`${name} must be true or false`);
  return value;
}

function normalizeAccount(input, existing, requireProxy) {
  const source = existing?.id || 'web account';
  const name = stringField(
    input.name === undefined ? existing?.name : input.name,
    'name',
    80,
    { required: true },
  );
  const email = stringField(
    input.email === undefined ? existing?.email : input.email,
    'email',
    254,
  );

  let authToken = input.authToken;
  if (existing && (authToken === undefined || authToken === '')) authToken = existing.authToken;
  authToken = stringField(authToken, 'authToken', 8192, { required: true });
  const normalizedToken = normalizeTokenEntry(authToken, source);

  let proxyUrl;
  if (input.removeProxy === true || input.proxyUrl === null) {
    proxyUrl = null;
  } else if (existing && (input.proxyUrl === undefined || input.proxyUrl === '')) {
    proxyUrl = existing.proxyUrl;
  } else {
    proxyUrl = stringField(input.proxyUrl, 'proxyUrl', 2048) || null;
  }

  const proxyRequired = booleanField(
    input.proxyRequired,
    existing?.proxyRequired ?? requireProxy,
    'proxyRequired',
  );
  const enabled = booleanField(input.enabled, existing?.enabled ?? true, 'enabled');
  const route = createAccountRoute({
    token: normalizedToken.token,
    tokenEntry: normalizedToken.tokenEntry,
    source,
    proxyUrl,
    proxyRequired: enabled ? proxyRequired : false,
  });
  if (enabled && requireProxy && !route.proxy) {
    throw new AccountServiceError('an enabled account requires proxyUrl in strict proxy mode');
  }

  return {
    id: existing?.id,
    name,
    email,
    authToken: normalizedToken.tokenEntry,
    token: normalizedToken.token,
    proxyUrl,
    proxyRequired,
    enabled,
    createdAt: existing?.createdAt,
    updatedAt: existing?.updatedAt,
    lastProxyStatus: existing?.lastProxyStatus,
    lastProxyHttpStatus: existing?.lastProxyHttpStatus,
    lastProxyMessage: existing?.lastProxyMessage,
    lastProxyTestAt: existing?.lastProxyTestAt,
  };
}

function accountRoute(account) {
  const normalized = normalizeTokenEntry(account.authToken, account.id || account.source || 'account');
  return createAccountRoute({
    token: normalized.token,
    tokenEntry: normalized.tokenEntry,
    source: account.id || account.source || 'account',
    proxyUrl: account.proxyUrl,
    proxyRequired: account.proxyRequired,
  });
}

export function importLegacyCredentials(store, records, { requireProxy = true } = {}) {
  if (!store || store.getSetting('legacy_import_completed') === 'true') {
    return { imported: 0, disabled: 0 };
  }
  if (store.countAccounts() > 0) {
    store.setSetting('legacy_import_completed', 'true');
    return { imported: 0, disabled: 0 };
  }
  if (records.length === 0) return { imported: 0, disabled: 0 };
  let disabled = 0;
  store.transaction(() => {
    for (const record of records) {
      const enabled = record.enabled && (!requireProxy || Boolean(record.proxyUrl));
      if (record.enabled && !enabled) disabled += 1;
      const normalized = normalizeAccount({
        name: record.name,
        email: record.email,
        authToken: record.authToken,
        proxyUrl: record.proxyUrl,
        proxyRequired: record.proxyRequired || requireProxy,
        enabled,
      }, null, requireProxy);
      store.createAccount(normalized);
    }
    store.appendAudit({
      actor: 'system',
      action: 'accounts.imported',
      summary: `Imported ${records.length} legacy account records; ${disabled} disabled pending proxy configuration`,
    });
    store.setSetting('legacy_import_completed', 'true');
  });
  return { imported: records.length, disabled };
}

export class AccountRuntime {
  constructor({
    store = null,
    staticAccounts = [],
    environmentAccounts = [],
    requireProxy = true,
    protectedHosts,
    connectTimeoutMs = 10000,
    retireMs = 300000,
  }) {
    this.store = store;
    this.staticAccounts = staticAccounts;
    this.environmentAccounts = environmentAccounts;
    this.options = { requireProxy, protectedHosts, connectTimeoutMs, retireMs };
    this.proxyManager = null;
    this.accountStateInvalidator = null;
    this.generation = 0;
    this.snapshot = Object.freeze({
      generation: 0,
      tokenLines: [],
      tokenString: '',
      managedAccountIds: [],
      managedAccountTokens: [],
      stats: null,
    });
  }

  #managedAccounts() {
    if (this.store) return this.store.listAccounts({ includeSecrets: true });
    return this.staticAccounts;
  }

  #buildSnapshot() {
    const managed = this.#managedAccounts().filter((account) => (
      account.enabled !== false && account.effectiveEnabled !== false
    ));
    const managedRoutes = managed.map(accountRoute);
    const routes = [...managedRoutes, ...this.environmentAccounts];
    return {
      routes,
      tokenLines: routes.map((route) => route.tokenEntry),
      managedAccountIds: managed.map((account) => account.id).filter(Boolean),
      managedAccountTokens: managedRoutes.map((route) => route.token),
    };
  }

  initialize() {
    const next = this.#buildSnapshot();
    this.proxyManager = installReloadableAccountProxyFetch(next.routes, this.options);
    this.generation += 1;
    const tokenLines = Object.freeze([...next.tokenLines]);
    this.snapshot = Object.freeze({
      generation: this.generation,
      tokenLines,
      tokenString: tokenLines.join(','),
      managedAccountIds: Object.freeze([...next.managedAccountIds]),
      managedAccountTokens: Object.freeze([...next.managedAccountTokens]),
      stats: Object.freeze({ ...this.proxyManager.stats }),
    });
    return this.snapshot;
  }

  reload({ invalidateTokens = [] } = {}) {
    if (!this.proxyManager) throw new Error('account runtime is not initialized');
    const next = this.#buildSnapshot();
    const stats = this.proxyManager.reload(next.routes);
    this.generation += 1;
    const tokenLines = Object.freeze([...next.tokenLines]);
    this.snapshot = Object.freeze({
      generation: this.generation,
      tokenLines,
      tokenString: tokenLines.join(','),
      managedAccountIds: Object.freeze([...next.managedAccountIds]),
      managedAccountTokens: Object.freeze([...next.managedAccountTokens]),
      stats: Object.freeze({ ...stats }),
    });
    this.accountStateInvalidator?.(invalidateTokens, this.tokenString, this.snapshot.generation);
    return this.snapshot;
  }

  get tokenString() {
    return this.snapshot.tokenString;
  }

  activeManagedAccountIdForToken(token, generation) {
    if (String(generation) !== String(this.snapshot.generation)) return null;
    const index = this.snapshot.managedAccountTokens.indexOf(String(token || '').trim());
    return index >= 0 ? this.snapshot.managedAccountIds[index] || null : null;
  }

  runWithCurrentProxySnapshot(operation) {
    if (!this.proxyManager) throw new Error('account runtime is not initialized');
    const snapshot = this.snapshot;
    return this.proxyManager.runWithCurrent(() => operation(snapshot));
  }

  setAccountStateInvalidator(invalidator) {
    if (typeof invalidator !== 'function') throw new TypeError('invalidator must be a function');
    this.accountStateInvalidator = invalidator;
    invalidator([], this.tokenString, this.snapshot.generation);
  }

  mapHealth(accountDetails = []) {
    const mapped = new Map();
    for (const [index, detail] of accountDetails.entries()) {
      if (detail?.accountGeneration !== undefined && detail.accountGeneration !== this.snapshot.generation) continue;
      const id = detail?.accountId || this.snapshot.managedAccountIds[index];
      if (id && detail) mapped.set(id, detail);
    }
    return mapped;
  }

  async close() {
    await this.proxyManager?.close();
    this.proxyManager?.restore();
  }
}

export class AccountService {
  constructor({
    store,
    runtime,
    requireProxy = true,
    connectTimeoutMs = 10000,
    modelTester = testAccountModel,
    modelCatalog = listTestModels,
    recoveryProbe = probeAccountRecovery,
    upstreamBaseUrl,
  }) {
    this.store = store;
    this.runtime = runtime;
    this.requireProxy = requireProxy;
    this.connectTimeoutMs = connectTimeoutMs;
    this.modelTester = modelTester;
    this.modelCatalog = modelCatalog;
    this.recoveryProbe = recoveryProbe;
    this.upstreamBaseUrl = upstreamBaseUrl;
    this.mutationChain = Promise.resolve();
  }

  #exclusive(operation) {
    const run = this.mutationChain.then(operation, operation);
    this.mutationChain = run.catch(() => {});
    return run;
  }

  #translateError(error) {
    if (error instanceof AccountServiceError) return error;
    if (error instanceof AccountProxyConfigError) {
      return new AccountServiceError(
        'account proxy configuration is invalid; edit the account and save the proxy again',
        400,
        'ACCOUNT_PROXY_INVALID',
      );
    }
    if (error instanceof AdminModelTestError) {
      return new AccountServiceError(error.message, error.status, error.code);
    }
    if (/UNIQUE constraint failed: accounts\.token_fingerprint/i.test(error?.message || '')) {
      return new AccountServiceError('this Freebuff token is already managed', 409, 'ACCOUNT_DUPLICATE');
    }
    return error;
  }

  #recordConnectionFailure(id, actor, account, { mode = 'proxy', code, message }) {
    const result = {
      ok: false,
      mode,
      code,
      latencyMs: 0,
      message,
    };
    let updated;
    this.store.transaction(() => {
      updated = this.store.setConnectionTest(id, result);
      this.store.appendAudit({
        actor,
        action: 'connection.test_failed',
        accountId: id,
        summary: `${mode === 'proxy' ? 'Proxy' : 'Connection'} test failed for ${account.name} (${code})`,
      });
    });
    return { result, account: updated };
  }

  observeRateLimit({ token, generation, retryAfterMs = null } = {}) {
    const normalizedToken = String(token || '').trim();
    if (!normalizedToken) return Promise.resolve({ changed: false, ignored: 'missing_token' });
    return this.#exclusive(async () => {
      // A Worker request may finish after an account edit/reload. Only the
      // currently active generation is allowed to pause a managed account.
      const accountId = this.runtime.activeManagedAccountIdForToken(normalizedToken, generation);
      if (!accountId) return { changed: false, ignored: 'stale_or_unmanaged' };
      const account = this.store.getAccount(accountId);
      if (!account?.enabled || account.autoPaused) return { changed: false, ignored: 'not_effective' };

      const observedAt = new Date();
      const paused = this.store.pauseAccountForRateLimit(accountId, {
        observedAt,
        nextProbeAt: recoveryProbeAt(observedAt, retryAfterMs),
        message: 'Freebuff returned a rate-limited response; automatic recovery is scheduled',
      });
      if (!paused.changed) return paused;

      this.runtime.reload({ invalidateTokens: [normalizedToken] });
      this.store.appendAudit({
        actor: 'system',
        action: 'account.rate_limit_paused',
        accountId,
        summary: `Automatically paused ${account.name} after a Freebuff rate limit`,
      });
      return paused;
    });
  }

  async runRecoveryProbes({ owner, now = new Date(), leaseMs = 60000, limit = 1 } = {}) {
    const claimed = this.store.claimDueRecoveryProbes(now, owner, leaseMs, limit);
    const outcomes = [];
    for (const account of claimed) {
      const route = accountRoute(account);
      const token = route.token;
      let result;
      try {
        result = await this.recoveryProbe(route, {
          connectTimeoutMs: this.connectTimeoutMs,
          requireProxy: this.requireProxy,
          protectedHosts: this.runtime.options.protectedHosts,
          upstreamBaseUrl: this.upstreamBaseUrl,
        });
      } catch {
        result = {
          recovered: false,
          state: 'probe_error',
          message: 'The recovery probe could not complete',
          retryAfterMs: null,
        };
      }

      const checkedAt = new Date();
      const recovered = result?.recovered === true && result?.state === 'recovered';
      const outcome = await this.#exclusive(async () => {
        const input = {
          owner,
          revision: account.stateRevision,
          state: result?.state || 'unknown',
          message: recoveryResultMessage(result, token),
          checkedAt,
        };
        const finished = recovered
          ? this.store.completeRecoveryProbe(account.id, input)
          : this.store.keepRecoveryPaused(account.id, {
              ...input,
              nextProbeAt: recoveryProbeAt(checkedAt, result?.retryAfterMs),
            });
        if (finished.changed && recovered) {
          this.runtime.reload({ invalidateTokens: [token] });
          this.store.appendAudit({
            actor: 'system',
            action: 'account.rate_limit_recovered',
            accountId: account.id,
            summary: `Automatically restored ${account.name} after Freebuff recovery check`,
          });
        }
        return finished;
      });
      outcomes.push({
        accountId: account.id,
        changed: outcome.changed,
        recovered: recovered && outcome.changed,
        state: result?.state || 'unknown',
      });
    }
    return outcomes;
  }

  list(accountDetails = []) {
    const health = this.runtime.mapHealth(accountDetails);
    return this.store.listAccounts().map((account) => {
      const observation = health.get(account.id);
      return {
        ...account,
        canTestConnection: account.hasProxy || (!this.requireProxy && !account.proxyRequired),
        canTestProxy: account.hasProxy,
        canTestModel: !account.effectiveEnabled && (account.hasProxy || (!this.requireProxy && !account.proxyRequired)),
        connectionTestMode: account.hasProxy ? 'proxy' : 'direct',
        upstreamAlive: account.effectiveEnabled ? observation?.alive ?? null : account.autoPaused ? false : null,
        upstreamState: !account.enabled
          ? 'disabled'
          : account.autoPaused ? account.autoPauseReason : observation?.state || 'unknown',
      };
    });
  }

  get(id, { includeSecrets = false } = {}) {
    const account = this.store.getAccount(id, { includeSecrets });
    if (!account) throw new AccountServiceError('account not found', 404, 'ACCOUNT_NOT_FOUND');
    return account;
  }

  create(input, actor = 'admin') {
    return this.#exclusive(async () => {
      let created;
      let normalized;
      try {
        normalized = normalizeAccount(input, null, this.requireProxy);
        created = this.store.createAccount(normalized);
        this.runtime.reload({ invalidateTokens: [normalized.token] });
        this.store.setSetting('legacy_import_completed', 'true');
        this.store.appendAudit({
          actor,
          action: 'account.created',
          accountId: created.id,
          summary: `Created account ${created.name}`,
        });
        return this.store.getAccount(created.id);
      } catch (error) {
        if (created) {
          this.store.deleteAccount(created.id);
          try { this.runtime.reload({ invalidateTokens: [normalized.token] }); } catch {}
        }
        throw this.#translateError(error);
      }
    });
  }

  update(id, input, actor = 'admin') {
    return this.#exclusive(async () => {
      const before = this.get(id, { includeSecrets: true });
      const beforeToken = normalizeTokenEntry(before.authToken, id).token;
      let mutated = false;
      let invalidateTokens = [];
      try {
        const normalized = normalizeAccount(input, before, this.requireProxy);
        const replacement = {
          ...normalized,
          id,
          createdAt: before.createdAt,
          updatedAt: new Date().toISOString(),
        };
        this.store.transaction(() => this.store.replaceAccount(replacement));
        mutated = true;
        const routeChanged = beforeToken !== normalized.token
          || before.authToken !== normalized.authToken
          || before.proxyUrl !== normalized.proxyUrl
          || before.proxyRequired !== normalized.proxyRequired
          || before.enabled !== normalized.enabled;
        invalidateTokens = routeChanged
          ? [...new Set([beforeToken, normalized.token])]
          : [];
        this.runtime.reload({ invalidateTokens });
        this.store.appendAudit({
          actor,
          action: 'account.updated',
          accountId: id,
          summary: `Updated account ${replacement.name}`,
        });
        return this.store.getAccount(id);
      } catch (error) {
        if (mutated) {
          try {
            const restored = normalizeAccount({}, before, this.requireProxy);
            this.store.transaction(() => this.store.replaceAccount({
              ...restored,
              id,
              createdAt: before.createdAt,
              updatedAt: before.updatedAt,
            }));
            this.runtime.reload({ invalidateTokens });
          } catch {}
        }
        throw this.#translateError(error);
      }
    });
  }

  delete(id, actor = 'admin') {
    return this.#exclusive(async () => {
      const before = this.get(id, { includeSecrets: true });
      const beforeToken = normalizeTokenEntry(before.authToken, id).token;
      try {
        this.store.deleteAccount(id);
        this.runtime.reload({ invalidateTokens: [beforeToken] });
        this.store.appendAudit({
          actor,
          action: 'account.deleted',
          accountId: id,
          summary: `Deleted account ${before.name}`,
        });
      } catch (error) {
        try {
          const restored = normalizeAccount({}, before, this.requireProxy);
          this.store.createAccount({ ...restored, id, createdAt: before.createdAt });
          this.runtime.reload({ invalidateTokens: [beforeToken] });
        } catch {}
        throw this.#translateError(error);
      }
    });
  }

  testConnection(id, actor = 'admin', options = {}) {
    return this.#exclusive(async () => {
      try {
        const account = this.get(id, { includeSecrets: true });
        if (!account.proxyUrl && (this.requireProxy || account.proxyRequired)) {
          const message = 'configure a proxy before testing this account because proxy routing is required';
          this.#recordConnectionFailure(id, actor, account, {
            mode: 'proxy',
            code: 'ACCOUNT_PROXY_MISSING',
            message,
          });
          throw new AccountServiceError(
            message,
            400,
            'ACCOUNT_PROXY_MISSING',
          );
        }
        const route = accountRoute(account);
        const result = await probeAccountConnection(route, {
          connectTimeoutMs: this.connectTimeoutMs,
          ...options,
        });
        const connectionLabel = result.mode === 'direct' ? 'Direct connection' : 'Proxy connection';
        let updated;
        this.store.transaction(() => {
          updated = this.store.setConnectionTest(id, result);
          this.store.appendAudit({
            actor,
            action: result.ok ? 'connection.test_succeeded' : 'connection.test_failed',
            accountId: id,
            summary: result.ok
              ? `${connectionLabel} test succeeded for ${account.name}`
              : `${connectionLabel} test failed for ${account.name}`,
          });
        });
        return { result, account: updated };
      } catch (error) {
        throw this.#translateError(error);
      }
    });
  }

  testProxy(id, actor = 'admin', options = {}) {
    return this.testConnection(id, actor, options);
  }

  listTestModels() {
    return this.modelCatalog();
  }

  testProxyConnection(id, actor = 'admin', options = {}) {
    return this.#exclusive(async () => {
      try {
        const account = this.get(id, { includeSecrets: true });
        if (!account.proxyUrl) {
          const message = 'configure a proxy before running the proxy test';
          this.#recordConnectionFailure(id, actor, account, {
            mode: 'proxy',
            code: 'ACCOUNT_PROXY_MISSING',
            message,
          });
          throw new AccountServiceError(
            message,
            400,
            'ACCOUNT_PROXY_MISSING',
          );
        }
        const route = accountRoute(account);
        const result = await probeAccountProxyStages(route, {
          connectTimeoutMs: this.connectTimeoutMs,
          ...options,
        });
        let updated;
        this.store.transaction(() => {
          updated = this.store.setConnectionTest(id, result);
          this.store.appendAudit({
            actor,
            action: result.ok ? 'proxy.test_succeeded' : 'proxy.test_failed',
            accountId: id,
            summary: result.ok
              ? `Proxy and Freebuff test succeeded for ${account.name}`
              : `Proxy test failed for ${account.name} at ${result.stage || 'unknown'} stage`,
          });
        });
        return { result, account: updated };
      } catch (error) {
        throw this.#translateError(error);
      }
    });
  }

  testModel(id, model, actor = 'admin', options = {}) {
    return this.#exclusive(async () => {
      try {
        const account = this.get(id, { includeSecrets: true });
        // The upstream session endpoint can replace an active live session.
        // Keep real probes isolated from accounts currently serving traffic.
        if (account.effectiveEnabled) {
          throw new AccountServiceError(
            'disable this account before running a model test to avoid interrupting live Freebuff sessions',
            409,
            'ACCOUNT_MODEL_TEST_REQUIRES_DISABLED',
          );
        }
        if (!account.proxyUrl && (this.requireProxy || account.proxyRequired)) {
          throw new AccountServiceError(
            'configure a proxy before testing this account because proxy routing is required',
            400,
            'ACCOUNT_PROXY_MISSING',
          );
        }
        const result = await this.modelTester(account, model, {
          connectTimeoutMs: this.connectTimeoutMs,
          ...options,
        });
        this.store.appendAudit({
          actor,
          action: result.ok ? 'model.test_succeeded' : 'model.test_failed',
          accountId: id,
          summary: result.ok
            ? `Model test succeeded for ${account.name} (${result.model})`
            : `Model test failed for ${account.name} (${result.model || String(model || 'unknown')}: ${result.category || 'unknown'})`,
        });
        return { result, account: this.store.getAccount(id) };
      } catch (error) {
        throw this.#translateError(error);
      }
    });
  }
}
