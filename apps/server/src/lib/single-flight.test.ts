import { createSingleFlight } from './single-flight';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('capacity counts distinct emails and allows duplicates to join the active read', async () => {
  const read = createSingleFlight<string>({ limit: () => 1, full: () => new Error('busy') });
  let release!: (value: string) => void;
  const first = read('a', () => new Promise<string>(resolve => { release = resolve; }));
  const duplicate = read('a', async () => 'must not execute');
  await assert.rejects(read('b', async () => 'b'), /busy/);
  release('a');
  assert.deepEqual(await Promise.all([first, duplicate]), ['a', 'a']);
  assert.equal(await read('b', async () => 'b'), 'b');
});

test('simultaneous readers share one request, including attachment and translation consumers', async () => {
  const read = createSingleFlight<string>();
  let calls = 0,
    release!: (value: string) => void;
  const load = () => {
    calls++;
    return new Promise<string>((resolve) => {
      release = resolve;
    });
  };
  const requests = Array.from({ length: 8 }, () => read('owner/mailbox/message', load));
  await Promise.resolve();
  assert.equal(calls, 1);
  release('mail');
  assert.deepEqual(await Promise.all(requests), Array(8).fill('mail'));
  await read('owner/mailbox/message', async () => {
    calls++;
    return 'updated';
  });
  assert.equal(calls, 2, 'completed results are not retained across mutations');
});

test('different owners or messages never share results and failed reads can be retried explicitly', async () => {
  const read = createSingleFlight<string>();
  let calls = 0;
  const fail = async () => {
    calls++;
    throw new Error('BUSY');
  };
  await Promise.all([
    assert.rejects(read('a/message', fail)),
    assert.rejects(read('a/message', fail)),
  ]);
  assert.equal(calls, 1);
  assert.equal(await read('a/message', async () => 'a'), 'a');
  assert.deepEqual(
    await Promise.all([
      read('a/message', async () => 'a'),
      read('b/message', async () => 'b'),
      read('a/other', async () => 'other'),
    ]),
    ['a', 'b', 'other'],
  );
});
