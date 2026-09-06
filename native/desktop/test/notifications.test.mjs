import { NotificationFeed } from '../src/notifications.cjs';
import assert from 'node:assert/strict';
import test from 'node:test';
test('first connection skips history and subsequent pages notify only once', async () => {
  const state = {},
    shown = [];
  let cursor = '10',
    events = [];
  const feed = new NotificationFeed({
    fetchFeed: async (after) => ({ owner: 'one', cursor, events: after ? events : [] }),
    show: async (e) => shown.push(e.id),
    load: async (o) => state[o],
    save: async (o, s) => {
      state[o] = s;
    },
  });
  await feed.poll();
  assert.equal(state.one.cursor, '10');
  assert.deepEqual(shown, []);
  cursor = '11';
  events = [{ id: '11' }];
  await feed.poll();
  await feed.poll();
  assert.deepEqual(shown, ['11']);
});
test('failed delivery keeps cursor retryable and owner switches use separate state', async () => {
  const state = { one: { cursor: '1', seen: [] } },
    shown = [];
  let owner = 'one',
    fail = true;
  const feed = new NotificationFeed({
    fetchFeed: async () => ({ owner, cursor: '2', events: [{ id: '2' }] }),
    show: async (e) => {
      if (fail) throw Error('unavailable');
      shown.push(e.id);
    },
    load: async (o) => state[o],
    save: async (o, s) => {
      state[o] = s;
    },
  });
  await assert.rejects(feed.poll());
  assert.equal(state.one.cursor, '1');
  fail = false;
  await feed.poll();
  owner = 'two';
  await feed.poll();
  assert.equal(state.two.cursor, '2');
  assert.deepEqual(shown, ['2']);
});
test('concurrent polling does not duplicate event delivery', async () => {
  let release,
    calls = 0;
  const wait = new Promise((r) => {
    release = r;
  });
  const feed = new NotificationFeed({
    fetchFeed: async () => {
      calls++;
      await wait;
      return { owner: 'one', cursor: '0', events: [] };
    },
    show: async () => {},
    load: async () => null,
    save: async () => {},
  });
  const first = feed.poll();
  await feed.poll();
  release();
  await first;
  assert.equal(calls, 1);
});
