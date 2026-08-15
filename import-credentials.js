import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importLegacyCredentials } from './account-manager.js';
import { loadCredentialRecords, parseEnvBoolean } from './account-proxy.js';
import { AccountStore } from './account-store.js';
import { createCredentialVault } from './credential-vault.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function secretValue(name) {
  const direct = process.env[name];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const file = process.env[`${name}_FILE`];
  if (!file) return '';
  return readFileSync(resolve(file), 'utf8').trim();
}

const credentialDirectory = resolve(
  process.env.CREDENTIALS_DIR || resolve(__dirname, 'credentials'),
);
const databasePath = resolve(
  process.env.ACCOUNT_DB_PATH || resolve(__dirname, 'data', 'freebuff.sqlite'),
);
const requireProxy = parseEnvBoolean(
  process.env.REQUIRE_ACCOUNT_PROXY,
  true,
  'REQUIRE_ACCOUNT_PROXY',
);

const store = new AccountStore({
  databasePath,
  vault: createCredentialVault(secretValue('ACCOUNT_STORE_KEY')),
});

try {
  const alreadyCompleted = store.getSetting('legacy_import_completed') === 'true';
  const existingAccounts = store.countAccounts();
  if (alreadyCompleted || existingAccounts > 0) {
    if (!alreadyCompleted) store.setSetting('legacy_import_completed', 'true');
    console.log(`[import] skipped: database already initialized (${existingAccounts} accounts)`);
  } else {
    const records = loadCredentialRecords(credentialDirectory);
    if (records.length === 0) {
      throw new Error(`no credential records found in ${credentialDirectory}`);
    }
    const result = importLegacyCredentials(store, records, { requireProxy });
    console.log(`[import] completed: ${result.imported} accounts (${result.disabled} disabled)`);
  }
} finally {
  store.close();
}
