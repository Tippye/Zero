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
for (const action of ['read', 'unread', 'star', 'unstar'])
  await native('action', { ids: [page.threads[0].id], action });
const attachments = await native('attachments', { id: 'mbx.native-test-account.message-1' });
assert.equal(Buffer.from(attachments.attachments[0].body, 'base64').toString(), 'hello');
const outgoing = {
  accountId: 'native-test-account',
  to: [{ email: 'recipient@example.test' }],
  cc: [],
  bcc: [],
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
await native('send', { ...outgoing, to: [] }, 400);
await native(
  'send',
  { ...outgoing, attachments: [{ ...outgoing.attachments[0], size: 100 }] },
  400,
);
assert.equal((await native('send', { ...outgoing, draftId: saved.id })).success, true);
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
  'Native API: pairing, signed bearer, ownership, pagination, search, flags, attachments, draft/send and revocation passed.',
);
