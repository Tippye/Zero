import { setTimeout as delay } from 'node:timers/promises';
import { startWatchdog } from '../runtime/watchdog.mjs';

test('watchdog recycles sustained memory pressure but ignores a transient peak', async () => {
  const samples = [200, 200, 50, 200, 200, 200];
  let reason;
  const stop = startWatchdog({
    url: 'http://synthetic.invalid', intervalMs: 5, failures: 3,
    request: async () => new Response('ok'),
    memoryUsage: async () => samples.shift(), maxResidentBytes: 100,
    fail: value => { reason = value; },
  });
  try {
    await delay(80);
    assert.equal(reason, 'memory');
    assert.equal(samples.length, 0);
  } finally { stop(); }
});
import assert from 'node:assert/strict';
import test from 'node:test';

test('watchdog resets failures after recovery and fails a persistently dead child', async () => {
  let calls = 0,
    failed = 0;
  const stop = startWatchdog({
    url: 'http://synthetic.invalid',
    intervalMs: 5,
    failures: 3,
    request: async () => new Response('', { status: ++calls === 3 ? 200 : 503 }),
    fail: () => failed++,
  });
  try {
    await delay(80);
    assert.equal(calls, 6);
    assert.equal(failed, 1);
  } finally {
    stop();
  }
});
