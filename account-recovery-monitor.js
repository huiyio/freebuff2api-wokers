import { randomUUID } from 'node:crypto';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_LEASE_MS = 60 * 1000;
const DEFAULT_BATCH_SIZE = 50;

function positiveInteger(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}

// A monitor instance owns no account state itself. SQLite leases make recovery
// safe across restarts and prevent two Node processes from probing the same
// account at the same time.
export class AccountRecoveryMonitor {
  constructor({
    accountService,
    intervalMs = DEFAULT_INTERVAL_MS,
    leaseMs = DEFAULT_LEASE_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    owner = `recovery-${randomUUID()}`,
    now = () => new Date(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onError = () => {},
  }) {
    if (!accountService?.runRecoveryProbes) throw new TypeError('accountService.runRecoveryProbes is required');
    if (typeof now !== 'function' || typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
      throw new TypeError('recovery monitor timer functions are required');
    }
    this.accountService = accountService;
    this.intervalMs = positiveInteger(intervalMs, DEFAULT_INTERVAL_MS, 'recovery interval');
    this.leaseMs = positiveInteger(leaseMs, DEFAULT_LEASE_MS, 'recovery lease duration');
    this.batchSize = Math.min(50, positiveInteger(batchSize, DEFAULT_BATCH_SIZE, 'recovery batch size'));
    this.owner = String(owner || '').trim();
    if (!this.owner || this.owner.length > 128) throw new TypeError('recovery monitor owner is invalid');
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onError = onError;
    this.timer = null;
    this.running = null;
    this.stopped = true;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    // Existing suspended rows may already be due after a process restart.
    this.#schedule(0);
  }

  async stop() {
    this.stopped = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    await this.running;
  }

  async runOnce() {
    if (this.running) return this.running;
    const run = Promise.resolve().then(() => this.accountService.runRecoveryProbes({
      owner: this.owner,
      now: this.now(),
      leaseMs: this.leaseMs,
      limit: this.batchSize,
    }));
    this.running = run;
    try {
      return await run;
    } finally {
      if (this.running === run) this.running = null;
    }
  }

  #schedule(delay) {
    if (this.stopped || this.timer !== null) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.#tick();
    }, delay);
    this.timer?.unref?.();
  }

  async #tick() {
    if (this.stopped) return;
    try {
      await this.runOnce();
    } catch (error) {
      try { this.onError(error); } catch {}
    } finally {
      if (!this.stopped) this.#schedule(this.intervalMs);
    }
  }
}
