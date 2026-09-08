import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const origin = 'http://localhost:19180';
const compose = [
  'compose',
  '-p',
  'zero-pairing-test',
  '-f',
  'deploy/tests/compose.pairing.yaml',
  '-f',
  'deploy/tests/compose.apple.yaml',
];
function run(service, args, input) {
  const result = spawnSync('docker', [...compose, 'exec', '-T', service, ...args], {
    encoding: 'utf8',
    input,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const sql = (query) =>
  run('db', ['psql', '-U', 'zero', '-d', 'zero', '-At', '-v', 'ON_ERROR_STOP=1'], query).trim();
async function request(path, body, token, extra = {}) {
  return fetch(origin + '/api/' + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  });
}
sql('DELETE FROM mail0_pairing_rate;');
const pending = await (
  await request('pairing/start', { deviceName: 'Native integration fixture', mode: 'native' })
).json();
assert.ok(pending.userCode);
run('api', ['node', 'pairing.mjs', 'approve', pending.userCode, '--yes']);
const exchanged = await request('pairing/exchange', {
  requestId: pending.requestId,
  deviceSecret: pending.deviceSecret,
});
assert.equal(exchanged.status, 200);
const { token } = await exchanged.json();
assert.ok(token);
const cookie = exchanged.headers
  .getSetCookie()
  .map((c) => c.split(';')[0])
  .join('; ');
const native = async (operation, input = {}, status = 200) => {
  const response = await request('native/v1/' + operation, input, token);
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
};
assert.equal((await request('native/v1/accounts', {})).status, 401);
assert.equal((await request('native/v1/accounts', {}, undefined, { cookie })).status, 401);
assert.equal((await request('native/v1/accounts', {}, 'forged')).status, 401);
const accounts = await native('accounts');
assert.equal(accounts.accounts[0].id, 'native-test-account');
const owner = sql('SELECT user_id FROM mail0_pairing_owner WHERE id=1;');
assert.match(owner, /^[a-zA-Z0-9-]+$/);
sql(
  `INSERT INTO mail0_sync_accounts(user_id,account_id,provider,email,name,status) VALUES ('${owner}','native-test-account','imap','me@example.test','Test','ready') ON CONFLICT DO NOTHING;`,
);
const full = await native('thread', { id: 'mbx.native-test-account.message-1' });
assert.equal(full.messages[0].text, 'Hello & welcome');
assert.equal(full.messages[0].attachments[0].body, undefined);
const preview = {
  messages: [],
  latest: {
    subject: 'Native fixture',
    sender: { email: 'sender@example.test' },
    receivedOn: '2026-09-07T00:00:00Z',
    decodedBody: '<p>Preview</p>',
  },
  hasUnread: true,
  labels: [{ name: 'UNREAD', id: 'UNREAD' }],
};
const eventAccount = 'native-events-' + randomUUID();
const otherOwner = randomUUID();
const eventHead = await native('events');
assert.deepEqual(eventHead.events, [], 'First notification fetch must establish a quiet baseline');
assert.equal(eventHead.owner, owner);
try {
  sql(`INSERT INTO mail0_user(id,name,email,email_verified,is_anonymous,created_at,updated_at)
    VALUES('${otherOwner}','Native event fixture','${otherOwner}@example.test',false,true,now(),now());
    INSERT INTO mail0_sync_accounts(user_id,account_id,provider,email,name,status)
    SELECT user_id,'${eventAccount}','imap','events@example.test','Native event fixture','ready'
    FROM (VALUES ('${owner}'),('${otherOwner}')) AS fixture(user_id);
    INSERT INTO mail0_cached_mail(user_id,account_id,native_id,folders,tags,received_at,search_text,preview,version)
    VALUES('${owner}','${eventAccount}','historical',ARRAY['inbox'],ARRAY['UNREAD'],now(),'event fixture','${JSON.stringify(preview)}'::jsonb,'fixture');`);
  assert.deepEqual(
    (await native('events', { after: eventHead.cursor })).events,
    [],
    'Initial sync must not notify historical messages',
  );
  sql(`UPDATE mail0_sync_accounts SET last_synced_at=now() WHERE account_id='${eventAccount}';
    INSERT INTO mail0_cached_mail(user_id,account_id,native_id,folders,tags,received_at,search_text,preview,version)
    SELECT '${owner}','${eventAccount}','event-'||n,ARRAY['inbox'],ARRAY['UNREAD'],now(),'event fixture','${JSON.stringify(preview)}'::jsonb,'fixture' FROM generate_series(1,30) n;
    INSERT INTO mail0_cached_mail(user_id,account_id,native_id,folders,tags,received_at,search_text,version)
    VALUES('${otherOwner}','${eventAccount}','foreign-event',ARRAY['inbox'],ARRAY['UNREAD'],now(),'event fixture','fixture');`);
  const eventPage = await native('events', { after: eventHead.cursor, owner: otherOwner });
  assert.equal(eventPage.events.length, 25);
  assert.ok(
    eventPage.events.every(
      (event) => event.accountId === eventAccount && !event.threadId.includes('foreign-event'),
    ),
  );
  const desktopPage = await (
    await fetch(origin + '/api/desktop/events?after=' + eventHead.cursor, {
      headers: { Authorization: 'Bearer ' + token },
    })
  ).json();
  assert.deepEqual(
    eventPage,
    desktopPage,
    'Native and desktop must share the durable event contract',
  );
  const eventNext = await native('events', { after: eventPage.cursor });
  assert.equal(eventNext.events.length, 5, 'Events after the first 25 must remain available');
  assert.equal(
    new Set([...eventPage.events, ...eventNext.events].map((event) => event.id)).size,
    30,
  );
  assert.deepEqual(
    (await native('events')).events,
    [],
    'A new device must not replay prior events',
  );
  sql(`UPDATE mail0_cached_mail SET tags=ARRAY[]::text[] WHERE user_id='${owner}' AND account_id='${eventAccount}' AND native_id='event-1';
    UPDATE mail0_cached_mail SET folders=ARRAY['archive'] WHERE user_id='${owner}' AND account_id='${eventAccount}' AND native_id='event-2';
    UPDATE mail0_notification_events SET created_at=now()-interval '2 days' WHERE user_id='${owner}' AND account_id='${eventAccount}' AND native_id='event-3';
    DELETE FROM mail0_cached_mail WHERE user_id='${owner}' AND account_id='${eventAccount}' AND native_id='event-4';`);
  const filtered = await native('events', { after: eventHead.cursor });
  const filteredNext = await native('events', { after: filtered.cursor });
  assert.equal(
    filtered.events.length + filteredNext.events.length,
    26,
    'Read, archived, expired and deleted messages must not notify',
  );
  // Hold the joined table so a notification arrives between the head and row queries.
  // A completed page must never contain an event beyond the cursor it returns.
  const race = JSON.parse(
    run(
      'api',
      ['node', '--input-type=module'],
      `import postgres from 'postgres';
      import assert from 'node:assert/strict';
      const { owner, accountId, token } = ${JSON.stringify({ owner, accountId: eventAccount, token })};
      const options = { max: 1, onnotice: () => {} };
      const lock = postgres(process.env.DATABASE_URL, options);
      const observer = postgres(process.env.DATABASE_URL, options);
      const events = async (after) => {
        const response = await fetch('http://web/api/native/v1/events', {
          method: 'POST', headers: { Host: 'localhost:19180',
            'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify(after === undefined ? {} : { after }),
          signal: AbortSignal.timeout(15000),
        });
        assert.equal(response.status, 200);
        return response.json();
      };
      let pending;
      try {
        await observer.unsafe("INSERT INTO mail0_cached_mail(user_id,account_id,native_id,folders,tags,received_at,search_text,version) VALUES($1,$2,'concurrent-event',ARRAY['inbox'],ARRAY['UNREAD'],now()-interval '1 hour','event fixture','fixture')", [owner, accountId]);
        const before = await events();
        let inserted;
        await lock.begin(async (tx) => {
          await tx.unsafe('LOCK TABLE mail0_cached_mail IN ACCESS EXCLUSIVE MODE');
          pending = events(before.cursor);
          pending.catch(() => {});
          let waiting = false;
          const deadline = Date.now() + 10000;
          while (!waiting && Date.now() < deadline) {
            const [state] = await observer.unsafe("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND wait_event_type='Lock' AND query LIKE 'SELECT e.id::text AS id,%' AND query LIKE '%mail0_cached_mail%') AS waiting");
            waiting = state.waiting;
            if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
          }
          assert.equal(waiting, true, 'Feed join must be blocked after its head query');
          [inserted] = await observer.unsafe("INSERT INTO mail0_notification_events(user_id,account_id,native_id) VALUES($1,$2,'concurrent-event') RETURNING id::text AS id", [owner, accountId]);
        });
        const during = await pending;
        const after = await events(during.cursor);
        console.log(JSON.stringify({ before, during, after, inserted: inserted.id }));
      } finally {
        await Promise.all([lock.end(), observer.end()]);
      }`,
    ),
  );
  assert.equal(race.during.cursor, race.before.cursor);
  assert.deepEqual(race.during.events, [], 'Events newer than the page snapshot must wait');
  assert.deepEqual(
    race.after.events.map((event) => event.id),
    [race.inserted],
  );
  assert.ok(BigInt(race.after.cursor) >= BigInt(race.inserted));
  console.log('Notification snapshot race: late event deferred and delivered on next poll.');
  await native('events', { after: '1e3' }, 400);
  await native('events', { after: 10 }, 400);
  assert.equal((await request('native/v1/events', {})).status, 401);
} finally {
  sql(`DELETE FROM mail0_notification_events WHERE account_id='${eventAccount}';
    DELETE FROM mail0_sync_accounts WHERE account_id='${eventAccount}';
    DELETE FROM mail0_user WHERE id='${otherOwner}';`);
}
sql(`INSERT INTO mail0_cached_mail(user_id,account_id,native_id,folders,tags,received_at,search_text,preview,version)
SELECT '${owner}','native-test-account','message-'||n,ARRAY['inbox'],ARRAY['UNREAD'],now()-n*interval '1 minute','native fixture','${JSON.stringify(preview)}'::jsonb,'fixture' FROM generate_series(1,2) n ON CONFLICT DO NOTHING;`);
const page = await native('threads', { maxResults: 1 });
assert.equal(page.threads.length, 1);
assert.ok(page.cursor);
const next = await native('threads', { maxResults: 1, cursor: page.cursor });
assert.notEqual(page.threads[0].id, next.threads[0].id);
assert.equal(next.cursor, null);
assert.equal((await native('threads', { q: 'subject:native' })).threads.length, 2);
await native('threads', { q: 'other', cursor: page.cursor }, 400);
await native('thread', { id: 'mbx.foreign-account.message' }, 404);
await native('action', { ids: ['mbx.foreign-account.message'], action: 'trash' }, 404);
for (const action of ['read', 'unread', 'star', 'unstar']) {
  await native('action', { ids: [page.threads[0].id], action });
  const current = (await native('threads')).threads.find((item) => item.id === page.threads[0].id);
  const read = await native('thread', { id: page.threads[0].id });
  if (['read', 'unread'].includes(action)) {
    assert.equal(current.unread, action === 'unread');
    assert.equal(read.unread, action === 'unread');
  } else {
    assert.equal(current.starred, action === 'star');
    assert.equal(read.starred, action === 'star');
    const starred = await native('threads', { folder: 'starred' });
    assert.equal(
      starred.threads.some((item) => item.id === current.id),
      action === 'star',
    );
  }
}
await native(
  'action',
  { ids: [page.threads[0].id, 'mbx.foreign-account.message'], action: 'trash' },
  404,
);
assert.equal(
  (await native('threads')).threads.length,
  2,
  'Mixed ownership must fail before any mutation',
);
const attachments = await native('attachments', { id: 'mbx.native-test-account.message-1' });
assert.equal(Buffer.from(attachments.attachments[0].body, 'base64').toString(), 'hello');
const outgoing = {
  accountId: 'native-test-account',
  to: [{ email: 'recipient@example.test' }],
  cc: [{ email: 'copy@example.test' }],
  bcc: [{ email: 'hidden@example.test' }],
  subject: 'Draft fixture',
  message: '<b>Draft body</b>',
  operationId: randomUUID(),
  attachments: [
    { name: 'draft.txt', type: 'text/plain', size: 5, lastModified: 0, base64: 'aGVsbG8=' },
  ],
};
const saved = await native('save-draft', outgoing);
const draft = await native('draft', { id: saved.id });
assert.equal(draft.text, 'Draft body');
assert.equal(draft.attachments[0].body, 'aGVsbG8=');
assert.deepEqual(draft.to, ['recipient@example.test']);
assert.deepEqual(draft.cc, ['copy@example.test']);
assert.deepEqual(draft.bcc, ['hidden@example.test']);
const updated = await native('save-draft', {
  ...outgoing,
  draftId: saved.id,
  message: '<p>Edited draft</p>',
});
assert.equal(updated.id, saved.id);
assert.equal((await native('draft', { id: saved.id })).text, 'Edited draft');
await native('send', { ...outgoing, to: [], cc: [], bcc: [] }, 400);
await native(
  'send',
  { ...outgoing, attachments: [{ ...outgoing.attachments[0], size: 100 }] },
  400,
);
assert.equal((await native('send', { ...outgoing, draftId: saved.id })).success, true);
assert.equal(
  (await native('send', { ...outgoing, draftId: saved.id })).success,
  true,
  'A retry with the same operation must succeed',
);
await native('send', { ...outgoing, draftId: saved.id, subject: 'Changed uncertain send' }, 409);
assert.equal(
  (
    await native('send', {
      ...outgoing,
      operationId: randomUUID(),
      attachments: [
        {
          name: 'maximum.bin',
          type: 'application/octet-stream',
          size: 15 * 1024 * 1024,
          lastModified: 0,
          base64: Buffer.alloc(15 * 1024 * 1024, 65).toString('base64'),
        },
      ],
    })
  ).success,
  true,
);
await native('delete-draft', { id: saved.id });
await native('draft', { id: saved.id }, 400);
for (const [index, action] of ['archive', 'trash'].entries()) {
  await native('action', { ids: [(index ? next : page).threads[0].id], action });
  assert.equal(
    (await native('threads')).threads.length,
    1 - index,
    'Moved mail must disappear from inbox immediately',
  );
}
await native('sync');
await native('unknown-operation', {}, 404);
const directory = '/tmp/zero-apple-fixtures';
await mkdir(directory, { recursive: true });
for (const [name, value] of Object.entries({ accounts, page, thread: full, attachments, draft }))
  await writeFile(`${directory}/${name}.json`, JSON.stringify(value));
const devices = await (
  await fetch(origin + '/api/pairing/devices', { headers: { Authorization: 'Bearer ' + token } })
).json();
const current = devices.devices.find((d) => d.current);
assert.ok(current);
assert.equal((await request('pairing/revoke', { sessionId: current.id }, token)).status, 200);
await native('accounts', {}, 401);
console.log(
  'Native API: pairing, signed bearer, ownership, durable desktop/native events, pagination, search, flags, attachments, draft/send and revocation passed.',
);
