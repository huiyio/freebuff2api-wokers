ALTER TABLE accounts ADD COLUMN auto_pause_reason TEXT;
ALTER TABLE accounts ADD COLUMN auto_paused_at TEXT;
ALTER TABLE accounts ADD COLUMN next_recovery_probe_at TEXT;
ALTER TABLE accounts ADD COLUMN last_recovery_probe_at TEXT;
ALTER TABLE accounts ADD COLUMN last_recovery_state TEXT;
ALTER TABLE accounts ADD COLUMN last_recovery_message TEXT;
ALTER TABLE accounts ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (recovery_attempts >= 0);
ALTER TABLE accounts ADD COLUMN state_revision INTEGER NOT NULL DEFAULT 0 CHECK (state_revision >= 0);
ALTER TABLE accounts ADD COLUMN recovery_lease_owner TEXT;
ALTER TABLE accounts ADD COLUMN recovery_lease_until TEXT;

CREATE INDEX IF NOT EXISTS accounts_recovery_due_idx
  ON accounts(next_recovery_probe_at)
  WHERE enabled = 1 AND auto_pause_reason = 'rate_limited';

CREATE INDEX IF NOT EXISTS accounts_recovery_lease_idx
  ON accounts(recovery_lease_until)
  WHERE recovery_lease_until IS NOT NULL;

PRAGMA user_version = 2;
