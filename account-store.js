import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { maskProxyUrl, proxyProtocol } from './credential-vault.js';

const VAULT_SENTINEL = 'freebuff-account-store-v1';

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
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw new Error(`database schema version ${version} is newer than this application supports`);
    if (version === 0) {
      const sql = readFileSync(new URL('./migrations/001_initial.sql', import.meta.url), 'utf8');
      this.transaction(() => this.db.exec(sql));
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
    const account = {
      id: row.id,
      name: row.name,
      email: row.email,
      enabled: asBoolean(row.enabled),
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
        last_proxy_status, last_proxy_http_status, last_proxy_message, last_proxy_test_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    );
    return this.getAccount(id, { includeSecrets: true });
  }

  replaceAccount(input) {
    const existing = this.getAccount(input.id, { includeSecrets: true });
    if (!existing) throw new Error('account not found');
    this.deleteAccount(input.id);
    return this.createAccount({ ...input, createdAt: input.createdAt || existing.createdAt });
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
