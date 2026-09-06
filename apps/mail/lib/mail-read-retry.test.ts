import { mailReadRetryDelay, retryMailRead } from './mail-read-retry';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const busy = { data: { code: 'TOO_MANY_REQUESTS', httpStatus: 429 } };
const withWait = (value: string) => ({
  ...busy,
  meta: { response: { headers: new Headers({ 'Retry-After': value }) } },
});

test('only transient read failures retry, with a maximum of three retries', () => {
  for (const status of [408, 429, 502, 503, 504]) {
    assert.equal(retryMailRead(0, { data: { httpStatus: status } }), true);
  }
  for (const status of [400, 401, 403, 404, 500]) {
    assert.equal(retryMailRead(0, { data: { httpStatus: status } }), false);
  }
  assert.equal(retryMailRead(2, busy), true);
  assert.equal(retryMailRead(3, busy), false);
  assert.equal(retryMailRead(0, { ...busy, cause: { name: 'AbortError' } }), false);
  for (const error of [null, undefined, new Error('failure')]) {
    assert.equal(retryMailRead(0, error), false);
  }
});

test('exponential delays have bounded jitter and respect Retry-After', () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    for (let sample = 0; sample < 100; sample++) {
      const delay = mailReadRetryDelay(attempt, busy);
      assert.ok(delay >= 5_000 * 2 ** attempt && delay <= 6_000 * 2 ** attempt);
    }
  }
  const minuteDelay = mailReadRetryDelay(0, withWait('60'));
  assert.ok(minuteDelay >= 60_000 && minuteDelay <= 61_000);
  const dateWait = withWait(new Date(Date.now() + 60_000).toUTCString());
  assert.ok(mailReadRetryDelay(0, dateWait) >= 58_000);
  assert.equal(retryMailRead(0, withWait('121')), false);
  assert.equal(retryMailRead(0, withWait('invalid')), true);
});
