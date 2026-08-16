import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountRecoveryMonitor } from '../account-recovery-monitor.js';

test('schedules due recovery work every five minutes without overlapping probes', async () => {
  const timers = [];
  const cleared = [];
  let resolveFirst;
  const firstRun = new Promise((resolve) => { resolveFirst = resolve; });
  const calls = [];
  const service = {
    async runRecoveryProbes(input) {
      calls.push(input);
      if (calls.length === 1) await firstRun;
      return [];
    },
  };
  const monitor = new AccountRecoveryMonitor({
    accountService: service,
    owner: 'monitor-test-owner',
    now: () => new Date('2026-08-16T00:00:00.000Z'),
    setTimer: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => cleared.push(timer),
  });

  monitor.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 0);
  timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);

  const second = monitor.runOnce();
  assert.equal(calls.length, 1, 'an active recovery sweep must not be duplicated');
  resolveFirst();
  await second;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.length, 2);
  assert.equal(timers[1].delay, 5 * 60 * 1000);
  assert.equal(calls[0].owner, 'monitor-test-owner');
  assert.equal(calls[0].leaseMs, 60000);

  await monitor.stop();
  assert.deepEqual(cleared, [timers[1]]);
});

test('reports an asynchronous recovery failure and continues scheduling', async () => {
  const timers = [];
  const errors = [];
  const monitor = new AccountRecoveryMonitor({
    accountService: { runRecoveryProbes: async () => { throw new Error('probe failed'); } },
    owner: 'monitor-error-owner',
    setTimer: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {},
    onError: (error) => errors.push(error.message),
  });

  monitor.start();
  timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ['probe failed']);
  assert.equal(timers[1].delay, 5 * 60 * 1000);
  await monitor.stop();
});
