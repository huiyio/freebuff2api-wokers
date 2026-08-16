import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { maskProxyUrl, proxyProtocol } from './credential-vault.js';

const VAULT_SENTINEL = 'freebuff-account-store-v1';
const LATEST_SCHEMA_VERSION = 2;
const DEFAULT_RECOVERY_INTERVAL_MS = 5 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function asBoolean(value) {
  return value === 1;
}

function truncate(value, max = 240) {
  const text = String(value || '');
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function timestamp(value, fallback = nowIso()) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError('invalid timestamp');
  return parsed.toISOString();
}

function positiveInteger(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}

function leaseOwner(value) {
  const owner = String(value || '').trim();
  if (!owner || owner.length > 128 || /[\r\n\0]/.test(owner)) {
    throw new TypeError('recovery lease owner is invalid');
  }
  return owner;
}

export class AccountStore {
  constructor({ databasePath, vault }) {
    if (!databasePath) throw new Error('databasePath is required');
    if (!vault) throw new Error('vault is required');
    mkdirSync(dirname(databasePath), { recursive: true });
    this.databasePath = databasePath;
    this.vault = vault;
    this.db = new DatabaseSync(databasePath);
    try {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      this.#migrate();
      this.#verifyVault();
      try { chmodSync(databasePath, 0o600); } catch {}
    } catch (error) {
      try { this.db.close(); } catch {}
      throw error;
    }
  }

  #migrate() {
    const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
    if (version > LATEST_SCHEMA_VERSION) {
      throw new Error(`database schema version ${version} is newer than this application supports`);
    }
    const migrations = [
      null,
      '001_initial.sql',
      '002_account_auto_pause.sql',
    ];
    for (let next = version + 1; next <= LATEST_SCHEMA_VERSION; next += 1) {
      const sql = readFileSync(new URL(`./migrations/${migrations[next]}`, import.meta.url), 'utf8');
      this.transaction(() => this.db.exec(sql));
      const applied = Number(this.db.prepare('PRAGMA user_version').get().user_version);
      if (applied !== next) throw new Error(`database migration ${next} did not set the expected schema version`);
    }
  }

  #verifyVault() {
    const encrypted = this.getSetting('vault_check');
    if (!encrypted) {
      if (this.countAccounts() > 0) {
        throw new Error('vault verification record is missing for an existing account database');
      }
      this.setSetting('vault_check', this.vault.encrypt(VAULT_SENTINEL, 'settings:vault_check'));
      return;
    }
    const decrypted = this.vault.decrypt(encrypted, 'settings:vault_check');
    if (decrypted !== VAULT_SENTINEL) throw new Error('ACCOUNT_STORE_KEY verification failed');
  }

  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  getSetting(key) {
    return this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
  }

  setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, String(value), nowIso());
  }

  getSecretSetting(key, associatedData = `settings:${key}`) {
    const encrypted = this.getSetting(key);
    return encrypted ? this.vault.decrypt(encrypted, associatedData) : null;
  }

  setSecretSetting(key, value, associatedData = `settings:${key}`) {
    if (typeof value !== 'string' || !value) throw new Error('secret setting value is required');
    this.setSetting(key, this.vault.encrypt(value, associatedData));
  }

  countAccounts() {
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count);
  }

  #rowToAccount(row, includeSecrets = false) {
    if (!row) return null;
    const enabled = asBoolean(row.enabled);
    const autoPauseReason = row.auto_pause_reason || null;
    const account = {
      id: row.id,
      name: row.name,
      email: row.email,
      enabled,
      effectiveEnabled: enabled && !autoPauseReason,
      autoPaused: Boolean(autoPauseReason),
      autoPauseReason,
      autoPausedAt: row.auto_paused_at || null,
      nextRecoveryProbeAt: row.next_recovery_probe_at || null,
      lastRecoveryProbeAt: row.last_recovery_probe_at || null,
      lastRecoveryState: row.last_recovery_state || null,
      lastRecoveryMessage: row.last_recovery_message || null,
      recoveryAttempts: Number(row.recovery_attempts || 0),
      stateRevision: Number(row.state_revision || 0),
      proxyRequired: asBoolean(row.proxy_required),
      hasProxy: Boolean(row.proxy_url_cipher),
      proxyUrlMasked: null,
      proxyProtocol: null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastProxyStatus: row.last_proxy_status,
      lastProxyHttpStatus: row.last_proxy_http_status,
      lastProxyMessage: row.last_proxy_message,
      lastProxyTestAt: row.last_proxy_test_at,
    };
    if (includeSecrets) {
      account.authToken = this.vault.decrypt(row.auth_token_cipher, `account:${row.id}:authToken`);
      account.proxyUrl = row.proxy_url_cipher
        ? this.vault.decrypt(row.proxy_url_cipher, `account:${row.id}:proxyUrl`)
        : null;
      account.proxyUrlMasked = maskProxyUrl(account.proxyUrl);
      account.proxyProtocol = proxyProtocol(account.proxyUrl);
    } else if (row.proxy_url_cipher) {
      const proxyUrl = this.vault.decrypt(row.proxy_url_cipher, `account:${row.id}:proxyUrl`);
      account.proxyUrlMasked = maskProxyUrl(proxyUrl);
      account.proxyProtocol = proxyProtocol(proxyUrl);
    }
    return account;
  }

  listAccounts({ includeSecrets = false } = {}) {
    const rows = this.db.prepare('SELECT * FROM accounts ORDER BY created_at, id').all();
    return rows.map((row) => this.#rowToAccount(row, includeSecrets));
  }

  getAccount(id, { includeSecrets = false } = {}) {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    return this.#rowToAccount(row, includeSecrets);
  }

  createAccount(input) {
    const id = input.id || randomUUID();
    const createdAt = input.createdAt || nowIso();
    const updatedAt = input.updatedAt || createdAt;
    const tokenFingerprint = this.vault.fingerprint('freebuff-token', input.token);
    const authTokenCipher = this.vault.encrypt(input.authToken, `account:${id}:authToken`);
    const proxyUrlCipher = input.proxyUrl
      ? this.vault.encrypt(input.proxyUrl, `account:${id}:proxyUrl`)
      : null;
    this.db.prepare(`
      INSERT INTO accounts (
        id, name, email, auth_token_cipher, token_fingerprint, proxy_url_cipher,
        proxy_required, enabled, created_at, updated_at,
        last_proxy_status, last_proxy_http_status, last_proxy_message, last_proxy_test_at,
        auto_pause_reason, auto_paused_at, next_recovery_probe_at,
        last_recovery_probe_at, last_recovery_state, last_recovery_message,
        recovery_attempts, state_revision, recovery_lease_owner, recovery_lease_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.name,
      input.email || '',
      authTokenCipher,
      tokenFingerprint,
      proxyUrlCipher,
      input.proxyRequired ? 1 : 0,
      input.enabled ? 1 : 0,
      createdAt,
      updatedAt,
      input.lastProxyStatus || null,
      input.lastProxyHttpStatus || null,
      input.lastProxyMessage || null,
      input.lastProxyTestAt || null,
      input.autoPauseReason || null,
      input.autoPausedAt || null,
      input.nextRecoveryProbeAt || null,
      input.lastRecoveryProbeAt || null,
      input.lastRecoveryState || null,
      input.lastRecoveryMessage || null,
      Math.max(0, Number(input.recoveryAttempts) || 0),
      Math.max(0, Number(input.stateRevision) || 0),
      input.recoveryLeaseOwner || null,
      input.recoveryLeaseUntil || null,
    );
    return this.getAccount(id, { includeSecrets: true });
  }

  replaceAccount(input) {
    const existing = this.getAccount(input.id, { includeSecrets: true });
    if (!existing) throw new Error('account not found');
    const enabledChanged = Boolean(input.enabled) !== existing.enabled;
    const routeChanged = input.authToken !== existing.authToken
      || (input.proxyUrl || null) !== (existing.proxyUrl || null)
      || Boolean(input.proxyRequired) !== existing.proxyRequired;
    const preserveAutoPause = !enabledChanged && !routeChanged;
    const recoveryState = preserveAutoPause
      ? {
          autoPauseReason: existing.autoPauseReason,
          autoPausedAt: existing.autoPausedAt,
          nextRecoveryProbeAt: existing.nextRecoveryProbeAt,
          lastRecoveryProbeAt: existing.lastRecoveryProbeAt,
          lastRecoveryState: existing.lastRecoveryState,
          lastRecoveryMessage: existing.lastRecoveryMessage,
          recoveryAttempts: existing.recoveryAttempts,
        }
      : {
          autoPauseReason: null,
          autoPausedAt: null,
          nextRecoveryProbeAt: null,
          lastRecoveryProbeAt: existing.lastRecoveryProbeAt,
          lastRecoveryState: existing.lastRecoveryState,
          lastRecoveryMessage: existing.lastRecoveryMessage,
          recoveryAttempts: 0,
        };
    this.deleteAccount(input.id);
    return this.createAccount({
      ...input,
      ...recoveryState,
      createdAt: input.createdAt || existing.createdAt,
      stateRevision: existing.stateRevision + 1,
      recoveryLeaseOwner: null,
      recoveryLeaseUntil: null,
    });
  }

  deleteAccount(id) {
    return this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id).changes > 0;
  }

  setConnectionTest(id, result) {
    const testedAt = nowIso();
    this.db.prepare(`
      UPDATE accounts
      SET last_proxy_status = ?, last_proxy_http_status = ?, last_proxy_message = ?,
          last_proxy_test_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      result.ok ? 'ok' : 'error',
      result.httpStatus || null,
      truncate(result.message || (result.ok ? 'connection reachable' : 'connection test failed')),
      testedAt,
      testedAt,
      id,
    );
    return this.getAccount(id);
  }

  setProxyTest(id, result) {
    return this.setConnectionTest(id, result);
  }

  pauseAccountForRateLimit(id, {
    observedAt,
    nextProbeAt,
    message = 'Freebuff rate limited this account',
  } = {}) {
    const pausedAt = timestamp(observedAt);
    const nextAt = timestamp(nextProbeAt, new Date(Date.parse(pausedAt) + DEFAULT_RECOVERY_INTERVAL_MS).toISOString());
    const result = this.db.prepare(`
      UPDATE accounts
      SET auto_paused_at = ?,
          next_recovery_probe_at = ?,
          recovery_attempts = 0,
          auto_pause_reason = 'rate_limited',
          last_recovery_state = 'rate_limited',
          last_recovery_message = ?,
          recovery_lease_owner = NULL,
          recovery_lease_until = NULL,
          state_revision = state_revision + 1,
          updated_at = ?
      WHERE id = ? AND enabled = 1 AND auto_pause_reason IS NULL
    `).run(pausedAt, nextAt, truncate(message), pausedAt, id);
    return { changed: result.changes > 0, account: this.getAccount(id) };
  }

  claimDueRecoveryProbes(now, owner, leaseMs = 60000, limit = 1) {
    const claimedAt = timestamp(now);
    const claimedBy = leaseOwner(owner);
    const safeLeaseMs = positiveInteger(leaseMs, 60000, 'recovery lease duration');
    const safeLimit = Math.max(1, Math.min(50, positiveInteger(limit, 1, 'recovery probe limit')));
    const leaseUntil = new Date(Date.parse(claimedAt) + safeLeaseMs).toISOString();

    return this.transaction(() => {
      const due = this.db.prepare(`
        SELECT id
        FROM accounts
        WHERE enabled = 1
          AND auto_pause_reason = 'rate_limited'
          AND next_recovery_probe_at IS NOT NULL
          AND next_recovery_probe_at <= ?
          AND (recovery_lease_until IS NULL OR recovery_lease_until <= ?)
        ORDER BY next_recovery_probe_at, id
        LIMIT ?
      `).all(claimedAt, claimedAt, safeLimit);
      const claimed = [];
      const claim = this.db.prepare(`
        UPDATE accounts
        SET recovery_lease_owner = ?, recovery_lease_until = ?,
            last_recovery_probe_at = ?, last_recovery_state = 'probing',
            last_recovery_message = NULL,
            recovery_attempts = recovery_attempts + 1,
            state_revision = state_revision + 1,
            updated_at = ?
        WHERE id = ?
          AND enabled = 1
          AND auto_pause_reason = 'rate_limited'
          AND next_recovery_probe_at IS NOT NULL
          AND next_recovery_probe_at <= ?
          AND (recovery_lease_until IS NULL OR recovery_lease_until <= ?)
      `);
      for (const row of due) {
        const result = claim.run(
          claimedBy,
          leaseUntil,
          claimedAt,
          claimedAt,
          row.id,
          claimedAt,
          claimedAt,
        );
        if (result.changes === 0) continue;
        claimed.push({
          ...this.getAccount(row.id, { includeSecrets: true }),
          recoveryLeaseOwner: claimedBy,
          recoveryLeaseUntil: leaseUntil,
        });
      }
      return claimed;
    });
  }

  finishRecoveryProbe(id, {
    owner,
    revision,
    state,
    nextProbeAt,
    recovered = false,
    message = '',
    checkedAt,
  } = {}) {
    const checked = timestamp(checkedAt);
    const claimedBy = leaseOwner(owner);
    const expectedRevision = Number(revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('recovery state revision is invalid');
    }
    const nextState = truncate(state || (recovered ? 'recovered' : 'rate_limited'), 80);
    let result;
    if (recovered) {
      result = this.db.prepare(`
        UPDATE accounts
        SET auto_pause_reason = NULL, auto_paused_at = NULL,
            next_recovery_probe_at = NULL,
            last_recovery_probe_at = ?, last_recovery_state = ?, last_recovery_message = ?,
            recovery_lease_owner = NULL, recovery_lease_until = NULL,
            state_revision = state_revision + 1, updated_at = ?
        WHERE id = ? AND enabled = 1
          AND auto_pause_reason = 'rate_limited'
          AND state_revision = ? AND recovery_lease_owner = ?
      `).run(checked, nextState, truncate(message), checked, id, expectedRevision, claimedBy);
    } else {
      const nextAt = timestamp(nextProbeAt, new Date(Date.parse(checked) + DEFAULT_RECOVERY_INTERVAL_MS).toISOString());
      result = this.db.prepare(`
        UPDATE accounts
        SET next_recovery_probe_at = ?,
            last_recovery_probe_at = ?, last_recovery_state = ?, last_recovery_message = ?,
            recovery_lease_owner = NULL, recovery_lease_until = NULL,
            state_revision = state_revision + 1, updated_at = ?
        WHERE id = ? AND enabled = 1
          AND auto_pause_reason = 'rate_limited'
          AND state_revision = ? AND recovery_lease_owner = ?
      `).run(nextAt, checked, nextState, truncate(message), checked, id, expectedRevision, claimedBy);
    }
    return { changed: result.changes > 0, account: this.getAccount(id) };
  }

  completeRecoveryProbe(id, input = {}) {
    return this.finishRecoveryProbe(id, { ...input, recovered: true });
  }

  keepRecoveryPaused(id, input = {}) {
    return this.finishRecoveryProbe(id, { ...input, recovered: false });
  }

  clearAutoPause(id, { state = 'cleared', message = '', checkedAt } = {}) {
    const changedAt = timestamp(checkedAt);
    const result = this.db.prepare(`
      UPDATE accounts
      SET auto_pause_reason = NULL, auto_paused_at = NULL,
          next_recovery_probe_at = NULL,
          last_recovery_state = ?, last_recovery_message = ?,
          recovery_attempts = 0,
          recovery_lease_owner = NULL, recovery_lease_until = NULL,
          state_revision = state_revision + 1, updated_at = ?
      WHERE id = ? AND (
        auto_pause_reason IS NOT NULL
        OR recovery_lease_owner IS NOT NULL
        OR next_recovery_probe_at IS NOT NULL
      )
    `).run(truncate(state, 80), truncate(message), changedAt, id);
    return { changed: result.changes > 0, account: this.getAccount(id) };
  }

  cancelAutoPause(id, options = {}) {
    return this.clearAutoPause(id, { state: 'cancelled', ...options });
  }

  clearAutoPauseOnManualEnable(id, options = {}) {
    return this.clearAutoPause(id, { state: 'manual_enabled', ...options });
  }

  clearAutoPauseOnManualDisable(id, options = {}) {
    return this.clearAutoPause(id, { state: 'manual_disabled', ...options });
  }

  appendAudit({ actor = 'admin', action, accountId = null, summary }) {
    this.db.prepare(`
      INSERT INTO audit_log (actor, action, account_id, summary, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(actor, action, accountId, truncate(summary, 500), nowIso());
  }

  listAudit(limit = 50) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    return this.db.prepare(`
      SELECT id, actor, action, account_id AS accountId, summary, created_at AS createdAt
      FROM audit_log ORDER BY id DESC LIMIT ?
    `).all(safeLimit);
  }

  createSession(sessionHash, expiresAt) {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      INSERT INTO admin_sessions (session_hash, created_at, expires_at) VALUES (?, ?, ?)
    `).run(sessionHash, now, expiresAt);
  }

  getSession(sessionHash) {
    return this.db.prepare(`
      SELECT session_hash AS sessionHash, created_at AS createdAt, expires_at AS expiresAt
      FROM admin_sessions WHERE session_hash = ?
    `).get(sessionHash) || null;
  }

  deleteSession(sessionHash) {
    this.db.prepare('DELETE FROM admin_sessions WHERE session_hash = ?').run(sessionHash);
  }

  purgeSessions(now = Math.floor(Date.now() / 1000)) {
    return this.db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(now).changes;
  }

  deleteAllSessions() {
    this.db.exec('DELETE FROM admin_sessions');
  }

  close() {
    this.db.close();
  }
}
