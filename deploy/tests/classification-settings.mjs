// Uses only the isolated pairing stack and synthetic model; never production data.
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from '../../packages/testing/node_modules/@playwright/test/index.mjs';

const base = 'http://localhost:19180', model = 'http://localhost:19181';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const sql = (query) => docker('exec', 'zero-pairing-test-db-1', 'psql', '-U', 'zero', '-d', 'zero', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query);
const post = (action, body) => fetch(`${base}/api/pairing/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) });
const request = await (await post('start', { deviceName: 'Classification settings test', mode: 'cookie' })).json();
docker('exec', 'zero-pairing-test-api-1', 'node', 'pairing.mjs', 'approve', request.userCode, '--yes');
const exchanged = await post('exchange', { requestId: request.requestId, deviceSecret: request.deviceSecret });
assert.equal(exchanged.status, 200);
const cookies = exchanged.headers.getSetCookie().map((value) => value.split(';')[0]);
const cookie = cookies.join('; ');
async function rpc(name, input, authenticated = true) {
  const mutation = input !== undefined;
  const response = await fetch(`${base}/api/trpc/mailboxes.${name}`, {
    method: mutation ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', origin: base, ...(authenticated ? { cookie } : {}) },
    ...(mutation ? { body: JSON.stringify({ json: input }) } : {}),
  });
  const body = await response.json();
  return { status: response.status, data: body.result?.data?.json };
}
sql('DELETE FROM mail0_classification_settings WHERE user_id=(SELECT user_id FROM mail0_pairing_owner WHERE id=1)');
const initial = await rpc('classificationSettings');
assert.equal(initial.status, 200);
assert.equal(initial.data.settings.batch_size, 10);
assert.equal((await rpc('classificationSettings', undefined, false)).status, 401);
let settings = { concurrency: 2, batch_size: 25, interval_seconds: 2, timeout_seconds: 120, recent_days: 7, history_every_batches: 2 };
assert.equal((await rpc('saveClassificationSettings', settings, false)).status, 401);
for (const invalid of [{ concurrency: 0 }, { concurrency: 5 }, { batch_size: 51 }, { batch_size: 1.5 }, { interval_seconds: 1 }, { timeout_seconds: 121 }, { recent_days: 0 }, { history_every_batches: 101 }, { user_id: 'another-workspace' }]) {
  assert.equal((await rpc('saveClassificationSettings', { ...settings, ...invalid })).status, 400);
}
assert.equal((await rpc('saveClassificationSettings', settings)).status, 200);
assert.deepEqual((await rpc('classificationSettings')).data.settings, settings);
docker('restart', 'zero-pairing-test-api-1');
async function until(check, message, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    try { const result = await check(); if (result) return result; } catch { /* startup */ }
    await delay(500);
  }
  throw new Error(message);
}
await until(async () => (await rpc('classificationSettings')).status === 200, 'API did not recover');
assert.deepEqual((await rpc('classificationSettings')).data.settings, settings);
console.log('Settings API: authentication, validation, save/read and persistence after restart passed');

const browser = await chromium.launch({ headless: true, executablePath: process.env.ZERO_TEST_CHROMIUM, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1200, height: 1000 } });
  await context.addCookies(cookies.map((value) => { const pos = value.indexOf('='); return { name: value.slice(0, pos), value: value.slice(pos + 1), url: base }; }));
  const page = await context.newPage();
  await page.goto(`${base}/settings/llm`);
  const form = page.locator('[data-classification-limits]');
  await form.waitFor({ timeout: 30000 });
  assert.equal(await form.locator('input[name=batch_size]').inputValue(), '25');
  await form.locator('input[name=batch_size]').fill('0');
  assert.equal(await form.locator('button[type=submit]').isDisabled(), true);
  await form.locator('input[name=batch_size]').fill('3');
  await form.locator('button[type=submit]').click();
  await until(async () => (await rpc('classificationSettings')).data.settings.batch_size === 3, 'UI save did not persist');
  await page.reload();
  await form.waitFor({ timeout: 30000 });
  assert.equal(await form.locator('input[name=batch_size]').inputValue(), '3');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await form.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'settings overflow on mobile');
  await page.setViewportSize({ width: 1200, height: 1000 });
  await form.screenshot({ path: '/tmp/zero-classification-settings.png' });
  console.log('Browser: persisted values, invalid input, save/reload and mobile layout passed');
} finally { await browser.close(); }

settings = { ...settings, batch_size: 3 };
const owner = sql('SELECT user_id FROM mail0_pairing_owner WHERE id=1');
assert.match(owner, /^[a-zA-Z0-9-]+$/);
sql(`INSERT INTO mail0_sync_accounts(user_id,account_id,provider,email,name) SELECT '${owner}','classification-settings-'||i,'imap','synthetic@example.invalid','Synthetic' FROM generate_series(1,3) i`);
sql(`INSERT INTO mail0_cached_mail(user_id,account_id,native_id,folders,tags,received_at,search_text,preview,version) SELECT '${owner}','classification-settings-'||a,'message-'||i,ARRAY['inbox'],ARRAY[]::text[],now()-(CASE WHEN i<=3 THEN i-1 ELSE i*30 END)*interval '1 day','synthetic-'||i,jsonb_build_object('latest',jsonb_build_object('subject','account-'||a||'-message-'||i)),'synthetic' FROM generate_series(1,3) a CROSS JOIN generate_series(1,6) i`);
const fixture = 'zero-classification-model-test', worker = 'zero-classification-worker-test';
const stats = () => fetch(`${model}/stats`).then((r) => r.json());
const release = (ids) => fetch(`${model}/release`, { method: 'POST', body: JSON.stringify({ ids }) });
try {
  docker('run', '-d', '--rm', '--name', fixture, '--network', 'zero-pairing-test_default', '-p', '127.0.0.1:19181:3000', '--mount', `type=bind,src=${resolve('deploy/tests/classification-model.mjs')},dst=/model.mjs,readonly`, 'node:22-bookworm-slim', 'node', '/model.mjs');
  const address = docker('inspect', fixture, '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}');
  docker('run', '-d', '--rm', '--name', worker, '--network', 'zero-pairing-test_default', '-e', 'DATABASE_URL=postgresql://zero:synthetic-pairing-test@db:5432/zero', '-e', 'OPENAI_API_KEY=synthetic', '-e', 'OPENAI_MODEL=synthetic', '-e', `OPENAI_BASE_URL=http://${address}:3000/v1`, '-e', 'SELF_HOSTED=true', 'zero-classification-settings-sync:test', 'node', 'src/classifier.mjs');
  const first = await until(async () => { const state = await stats(); return state.pending.length === 2 && state; }, 'saved concurrency of 2 was not applied');
  assert.deepEqual(first.history[0].subjects.map((s) => s.split('-').at(-1)), ['1', '2', '3']);
  assert.deepEqual(first.history[1].subjects.map((s) => s.split('-').at(-1)), ['6', '5', '4']);
  await delay(2500);
  assert.equal((await stats()).history.length, 2);
  settings = { ...settings, concurrency: 1, batch_size: 1, interval_seconds: 4, recent_days: 14, history_every_batches: 1 };
  assert.equal((await rpc('saveClassificationSettings', settings)).status, 200);
  await release([first.pending[0]]);
  await delay(2500);
  assert.equal((await stats()).history.length, 2, 'lowered concurrency must block additional admission');
  await release([first.pending[1]]);
  const next = await until(async () => { const state = await stats(); return state.history.length === 3 && state; }, 'new batch did not start');
  assert.equal(next.pending.length, 1);
  assert.equal(next.history[2].subjects.length, 1);
  assert.ok(['3', '6'].includes(next.history[2].subjects[0].split('-').at(-1)), 'new batch must choose the oldest remaining email');
  console.log('Live scheduler: saved concurrency, batch cap, recent/oldest priority and lowering limits without restart passed');
} finally {
  for (const name of [worker, fixture]) { try { docker('rm', '-f', name); } catch {} }
  sql(`DELETE FROM mail0_sync_accounts WHERE user_id='${owner}' AND account_id LIKE 'classification-settings-%'`);
  await rpc('saveClassificationSettings', initial.data.settings);
}
