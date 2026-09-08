import { resourceLimits, nextPriority, classificationLimits } from '../src/limits.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

test('resource configuration rejects zero, unbounded and malformed concurrency', () => {
  for (const value of ['0', '-1', '1000', '1.5', 'invalid'])
    assert.throws(() => resourceLimits({ AI_CLASSIFY_CONCURRENCY: value }));
  const limits = resourceLimits({ AI_CLASSIFY_BATCH_SIZE: '3', SYNC_ACCOUNT_CONCURRENCY: '2' });
  assert.equal(limits.batchSize, 3);
  assert.equal(limits.syncAccounts, 2);
  assert.equal(limits.aiAccounts, 1);
});

test('saved workspace limits can increase defaults and remain bounded', () => {
  const settings = { concurrency: 3, batch_size: 25, interval_seconds: 17, timeout_seconds: 90, recent_days: 14, history_every_batches: 2 };
  const limits = classificationLimits({ AI_CLASSIFY_CONCURRENCY: '1', AI_CLASSIFY_BATCH_SIZE: '10' }, settings);
  assert.equal(limits.aiAccounts, 3);
  assert.equal(limits.batchSize, 25);
  assert.equal(limits.intervalSeconds, 17);
  assert.equal(limits.timeoutMs, 90000);
  assert.equal(limits.recentDays, 14);
  assert.equal(nextPriority(1, limits), 'oldest');
  assert.throws(() => classificationLimits({}, { ...settings, concurrency: 5 }));
  assert.equal(classificationLimits({ AI_CLASSIFY_BATCH_SIZE: '6' }).batchSize, 6);
});

test('recent mail receives most slots, with periodic oldest-first slots to prevent starvation', () => {
  const limits = resourceLimits({ AI_HISTORY_EVERY_BATCHES: '3' });
  assert.deepEqual(
    Array.from({ length: 6 }, (_, batch) => nextPriority(batch, limits)),
    ['recent', 'recent', 'oldest', 'recent', 'recent', 'oldest'],
  );
});
