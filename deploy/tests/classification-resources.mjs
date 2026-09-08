// Run in the sync image on the synthetic pairing-test network only.
import { classifyAccount } from './src/classify.mjs';
import assert from 'node:assert/strict';
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 2 });
const config = {
  OPENAI_API_KEY: 'synthetic',
  OPENAI_MODEL: 'synthetic',
  AI_CLASSIFY_BATCH_SIZE: '2',
  AI_CLASSIFY_INTERVAL_SECONDS: '17',
};
let selected = [];
const request = async (_url, options) => {
  const messages = JSON.parse(options.body).messages;
  selected = JSON.parse(messages.at(-1).content);
  return Response.json({
    choices: [
      {
        message: {
          content: JSON.stringify({
            results: selected.map((m) => ({ id: m.id, category: 'primary' })),
          }),
        },
      },
    ],
  });
};
const [{ user_id: owner }] = await sql`SELECT user_id FROM mail0_pairing_owner WHERE id=1`;
const account = { user_id: owner, account_id: 'synthetic-resource-test' };
const [savedSettings] = await sql`SELECT * FROM mail0_classification_settings WHERE user_id=${owner}`;
try {
  await sql`DELETE FROM mail0_classification_settings WHERE user_id=${owner}`;
  await sql`INSERT INTO mail0_sync_accounts(user_id,account_id,provider,email,name) VALUES(${owner},${account.account_id},'imap','resource@example.invalid','Synthetic resource test')`;
  for (const [id, days] of [
    ['newest', 0],
    ['recent', 1],
    ['old', 30],
    ['oldest', 90],
  ]) {
    await sql`INSERT INTO mail0_cached_mail(user_id,account_id,native_id,folders,tags,received_at,search_text,preview,version) VALUES(${owner},${account.account_id},${id},ARRAY['inbox'],ARRAY[]::text[],now()-${days}*interval '1 day',${id},${sql.json({ latest: { subject: id } })},'synthetic')`;
  }
  await classifyAccount(sql, config, account, request, 'recent');
  assert.deepEqual(
    selected.map((m) => m.subject),
    ['newest', 'recent'],
  );
  const [state] =
    await sql`SELECT classification_retry_at>now()+interval '15 seconds' AS delayed, classification_running_at FROM mail0_sync_accounts WHERE user_id=${owner} AND account_id=${account.account_id}`;
  assert.ok(state.delayed);
  assert.equal(state.classification_running_at, null);
  await classifyAccount(sql, config, account, request, 'oldest');
  assert.deepEqual(
    selected.map((m) => m.subject),
    ['oldest', 'old'],
  );
  const [result] =
    await sql`SELECT count(*)::int AS count FROM mail0_cached_mail WHERE user_id=${owner} AND account_id=${account.account_id} AND ai_category='primary'`;
  assert.equal(result.count, 4);
  console.log(
    'Classification SQL: batch cap, recent-first, oldest-first, cooldown and cleanup passed',
  );
  await sql`INSERT INTO mail0_classification_settings(user_id,concurrency,batch_size,interval_seconds,timeout_seconds,recent_days,history_every_batches) VALUES(${owner},1,25,17,60,7,5)`;
  await sql`INSERT INTO mail0_cached_mail(user_id,account_id,native_id,folders,tags,received_at,search_text,preview,version) SELECT ${owner},${account.account_id},'raised-'||i,ARRAY['inbox'],ARRAY[]::text[],now(),'raised-'||i,jsonb_build_object('latest',jsonb_build_object('subject','raised-'||i)),'synthetic' FROM generate_series(1,25) i`;
  await classifyAccount(sql, config, account, request, 'recent');
  assert.equal(selected.length, 25, 'saved cap above 10 must apply to a newly added mailbox');
  console.log('Classification SQL: saved batch size 25 overrides deployment defaults and the old 10-message cap');
} finally {
  await sql`DELETE FROM mail0_sync_accounts WHERE user_id=${owner} AND account_id=${account.account_id}`;
  await sql`DELETE FROM mail0_classification_settings WHERE user_id=${owner}`;
  if (savedSettings) await sql`INSERT INTO mail0_classification_settings ${sql(savedSettings)}`;
  await sql.end();
}
