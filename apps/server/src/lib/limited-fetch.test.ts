import { createLimitedFetch } from './limited-fetch';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('AI holds capacity while streaming and releases it on cancellation', async () => {
  let cancelled = false,
    calls = 0;
  const limited = createLimitedFetch(
    () => 1,
    async () => {
      calls++;
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      );
    },
  );
  const first = await limited('https://synthetic.invalid');
  const busy = await limited('https://synthetic.invalid');
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get('Retry-After'), '5');
  assert.equal(calls, 1);
  await first.body!.cancel();
  assert.ok(cancelled);
  const next = await limited('https://synthetic.invalid');
  assert.equal(calls, 2);
  await next.body!.cancel();
});

test('oversized responses and network failures release the AI slot', async () => {
  let attempt = 0;
  const limited = createLimitedFetch(
    () => 1,
    async () => {
      if (++attempt === 1) throw new Error('network failure');
      return new Response('too large');
    },
    1000,
    4,
  );
  await assert.rejects(limited('https://synthetic.invalid'), /network failure/);
  const response = await limited('https://synthetic.invalid');
  await assert.rejects(response.text(), /AI_RESPONSE_TOO_LARGE/);
  const next = await limited('https://synthetic.invalid');
  assert.equal(next.status, 200);
  await next.body!.cancel();
});

test('stalled bodies time out and do not retain capacity', async () => {
  const limited = createLimitedFetch(
    () => 1,
    async () => new Response(new ReadableStream()),
    20,
  );
  const response = await limited('https://synthetic.invalid');
  await assert.rejects(response.text(), { name: 'TimeoutError' });
  const next = await limited('https://synthetic.invalid');
  assert.equal(next.status, 200);
  await next.body!.cancel();
});

test('normal completion and already cancelled requests release capacity', async () => {
  const limited = createLimitedFetch(
    () => 1,
    async () => new Response('ok'),
  );
  await assert.rejects(limited('https://synthetic.invalid', { signal: AbortSignal.abort() }));
  for (let i = 0; i < 3; i++)
    assert.equal(await (await limited('https://synthetic.invalid')).text(), 'ok');
});
