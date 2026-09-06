const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const cfg = Object.fromEntries(
  readFileSync('deploy/.env', 'utf8')
    .split('\n')
    .filter((x) => x.includes('=') && !x.startsWith('#'))
    .map((x) => {
      const i = x.indexOf('=');
      return [x.slice(0, i), x.slice(i + 1)];
    }),
);
const origin = 'http://localhost:18080';
function db(source) {
  const r = spawnSync(
    'docker',
    ['exec', '-i', 'zero-compose-test-api-1', 'node', '--input-type=module'],
    {
      input:
        "import postgres from 'postgres'; const sql=postgres(process.env.DATABASE_URL);try{" +
        source +
        '}finally{await sql.end();}',
      encoding: 'utf8',
    },
  );
  if (r.status !== 0) throw Error(r.stderr || 'database fixture failed');
}
(async () => {
  const login = await fetch(origin + '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email: cfg.ADMIN_EMAIL, password: cfg.ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers
    .getSetCookie()
    .map((s) => s.split(';')[0])
    .join('; ');
  const head = await (await fetch(origin + '/api/desktop/events', { headers: { cookie } })).json();
  const owner = head.owner,
    other = randomUUID(),
    account = 'test-' + randomUUID();
  const vars = `const owner=${JSON.stringify(owner)},other=${JSON.stringify(other)},account=${JSON.stringify(account)};`;
  try {
    db(
      vars +
        "await sql`INSERT INTO mail0_user(id,name,email,email_verified,is_anonymous,created_at,updated_at) VALUES(${other},'Notification fixture',${other+'@example.invalid'},false,true,now(),now())`;for(const user of [owner,other])await sql`INSERT INTO mail0_sync_accounts(user_id,account_id,provider,email,name,next_sync_at) VALUES(${user},${account},'test','fixture@example.invalid','fixture',now()+interval '1 day')`;for(const user of [owner,other])await sql`INSERT INTO mail0_cached_mail(user_id,account_id,native_id,folders,tags,received_at,search_text,version) VALUES(${user},${account},'historical',ARRAY['inbox'],ARRAY['UNREAD'],now(),'fixture','1')`;await sql`UPDATE mail0_sync_accounts SET last_synced_at=now() WHERE account_id=${account}`;for(const user of [owner,other])await sql`INSERT INTO mail0_cached_mail(user_id,account_id,native_id,folders,tags,received_at,search_text,version) VALUES(${user},${account},'new-message',ARRAY['inbox'],ARRAY['UNREAD'],now(),'fixture','1')`;",
    );
    const events = await (
      await fetch(origin + '/api/desktop/events?after=' + head.cursor, { headers: { cookie } })
    ).json();
    assert.equal(
      events.events.length,
      1,
      'initial imports or other users leaked into notifications',
    );
    assert.ok(events.events[0].threadId.includes(account));
    if (process.env.ZERO_TEST_NOTIFICATION_WAIT === '1')
      await new Promise((resolve) => setTimeout(resolve, 35000));
    db(
      vars +
        'await sql`UPDATE mail0_cached_mail SET tags=ARRAY[]::text[] WHERE user_id=${owner} AND account_id=${account}`;',
    );
    const read = await (
      await fetch(origin + '/api/desktop/events?after=' + head.cursor, { headers: { cookie } })
    ).json();
    assert.equal(read.events.length, 0, 'already read mail should not notify');
    console.log(
      'PASS real SQL notification trigger: historical import suppression, new unread event, owner isolation, read filtering',
    );
  } finally {
    db(
      vars +
        'await sql`DELETE FROM mail0_notification_events WHERE account_id=${account}`;await sql`DELETE FROM mail0_sync_accounts WHERE account_id=${account}`;await sql`DELETE FROM mail0_user WHERE id=${other}`;',
    );
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
