import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const origin = 'http://localhost:19180';
const compose = ['compose', '-f', 'deploy/tests/compose.pairing.yaml'];
function cli(...args) {
  const result = spawnSync(
    'docker',
    [...compose, 'exec', '-T', 'api', 'node', 'pairing.mjs', ...args],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function sql(query) {
  const result = spawnSync(
    'docker',
    [
      ...compose,
      'exec',
      '-T',
      'db',
      'psql',
      '-U',
      'zero',
      '-d',
      'zero',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      query,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function post(action, body, cookie, extra = {}) {
  return fetch(origin + '/api/pairing/' + action, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      origin,
      ...(cookie ? { cookie } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  });
}
async function start(name, mode = 'cookie') {
  const r = await post('start', { deviceName: name, mode });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
async function exchange(request) {
  return post('exchange', { requestId: request.requestId, deviceSecret: request.deviceSecret });
}
const cookies = (r) =>
  r.headers
    .getSetCookie()
    .map((s) => s.split(';')[0])
    .join('; ');
async function who(cookie, token) {
  const r = await fetch(origin + '/api/auth/get-session', {
    headers: token ? { Authorization: 'Bearer ' + token } : { cookie },
  });
  return r.json();
}
let ready = false;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(origin + '/api/desktop/info');
    if (r.ok) {
      ready = true;
      break;
    }
  } catch {}
  await delay(1000);
}
assert.ok(ready, 'isolated API did not start');
sql('DELETE FROM mail0_pairing_rate');
for (const path of [
  'sign-in/email',
  'sign-up/email',
  'request-password-reset',
  'reset-password',
  'set-password',
  'sign-in/social',
  'phone-number/verify',
  'token',
]) {
  const r = await fetch(origin + '/api/auth/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', origin },
    body: JSON.stringify({ email: 'nobody@example.invalid', password: 'synthetic-password' }),
  });
  assert.equal(r.status, 403, path + ' must be disabled');
}
assert.equal((await fetch(origin + '/api/desktop/events')).status, 401);
assert.equal(
  (await post('start', { deviceName: 'CSRF' }, undefined, { origin: 'https://attacker.invalid' }))
    .status,
  403,
);
assert.equal(
  (await post('start', { deviceName: 'test' }, undefined, { 'Content-Type': 'text/plain' })).status,
  403,
);
const first = await start('First browser');
assert.match(first.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
assert.ok(!first.verificationUriComplete.includes(first.deviceSecret));
assert.equal((await post('preview', { code: first.userCode })).status, 401);
assert.equal(
  (await post('approve', { code: first.userCode, requestId: first.requestId })).status,
  401,
);
assert.equal((await (await exchange(first)).json()).status, 'authorization_pending');
assert.equal((await (await exchange(first)).json()).status, 'slow_down');
assert.equal((await exchange({ ...first, deviceSecret: '0'.repeat(64) })).status, 403);
cli('approve', first.userCode, '--yes');
await delay(4200);
const one = await exchange(first);
assert.equal(one.status, 200, await one.clone().text());
const firstCookie = cookies(one);
assert.ok(firstCookie.includes('session_token='));
assert.ok(one.headers.getSetCookie().every((v) => v.includes('HttpOnly') && !v.includes('Secure')));
assert.equal((await one.json()).token, undefined, 'browser response must not disclose token');
const identity = await who(firstCookie);
assert.ok(identity?.user?.id, 'Better Auth must accept pairing cookie');
assert.equal((await exchange(first)).status, 410, 'exchange must be single use');
const second = await start('Android / desktop');
const preview = await (await post('preview', { code: second.userCode }, firstCookie)).json();
assert.equal(preview.deviceName, 'Android / desktop');
assert.equal(
  (await post('approve', { code: second.userCode, requestId: first.requestId }, firstCookie))
    .status,
  404,
);
assert.equal(
  (await post('approve', { code: second.userCode, requestId: preview.requestId }, firstCookie))
    .status,
  200,
);
const race = await Promise.all([exchange(second), exchange(second)]);
assert.deepEqual(race.map((r) => r.status).sort(), [200, 410]);
const secondCookie = cookies(race.find((r) => r.status === 200));
assert.notEqual(firstCookie, secondCookie);
assert.equal((await who(secondCookie)).user.id, identity.user.id);
const denied = await start('Denied');
cli('deny', denied.userCode, '--yes');
assert.equal((await exchange(denied)).status, 403);
const expired = await start('Expired');
sql(
  `UPDATE mail0_pairing_request SET expires_at=now()-interval '1 second' WHERE id='${expired.requestId}'`,
);
assert.equal((await exchange(expired)).status, 410);
const native = await start('Apple native client', 'native');
cli('approve', native.userCode, '--yes');
const nativeResponse = await exchange(native);
const nativeAuth = await nativeResponse.json();
assert.equal(nativeAuth.status, 'authorized');
assert.ok(nativeAuth.token);
assert.equal(
  (await who('', nativeAuth.token))?.user?.id,
  identity.user.id,
  'native bearer must authenticate',
);
assert.equal(
  await who('', nativeAuth.token.split('.')[0]),
  null,
  'unsigned bearer must be rejected',
);
const deviceResponse = await fetch(origin + '/api/pairing/devices', {
  headers: { cookie: firstCookie },
});
const { devices } = await deviceResponse.json();
assert.ok(devices.some((d) => d.current));
assert.ok(
  devices.every((d) => !('token' in d)),
  'device list must not expose credentials',
);
const target = devices.find((d) => d.name === 'Android / desktop');
assert.equal((await post('revoke', { sessionId: target.id }, firstCookie)).status, 200);
assert.equal(await who(secondCookie), null, 'revocation must take effect immediately');
assert.equal(
  (await fetch(origin + '/api/desktop/events', { headers: { cookie: secondCookie } })).status,
  401,
);
assert.equal(
  (await who(firstCookie)).user.id,
  identity.user.id,
  'other device must remain signed in',
);
const restart = spawnSync('docker', [...compose, 'restart', 'api'], { encoding: 'utf8' });
assert.equal(restart.status, 0, restart.stderr);
let persisted = false;
for (let i = 0; i < 30; i++) {
  try {
    if ((await who(firstCookie))?.user?.id === identity.user.id) {
      persisted = true;
      break;
    }
  } catch {}
  await delay(1000);
}
assert.ok(persisted, 'paired session must survive API restart');
// Existing owner and sessions survive subsequent migrations; no password config exists.
const migration = spawnSync('docker', [...compose, 'exec', '-T', 'api', 'node', 'migrate.mjs'], {
  encoding: 'utf8',
});
assert.equal(migration.status, 0, migration.stderr);
assert.equal((await who(firstCookie)).user.id, identity.user.id);
const pending = await start('Pending at recovery');
cli('approve', pending.userCode, '--yes');
cli('revoke-all', '--yes');
assert.equal(await who(firstCookie), null);
assert.equal(await who('', nativeAuth.token), null);
assert.equal(
  (await exchange(pending)).status,
  403,
  'recovery revocation must cancel pending grants',
);
const recovered = await start('Recovered');
cli('approve', recovered.userCode, '--yes');
assert.equal(
  (await who(cookies(await exchange(recovered)))).user.id,
  identity.user.id,
  'recovery must retain workspace',
);
sql('DELETE FROM mail0_pairing_rate');
for (let i = 0; i < 20; i++)
  assert.equal((await post('start', { deviceName: 'Rate-limit test' })).status, 200);
assert.equal((await post('start', { deviceName: 'Rate-limit test' })).status, 429);
sql('DELETE FROM mail0_pairing_rate');
console.log(
  'PASS pairing: password endpoints blocked; origin checks; approval; private device secret; polling limits; single-use concurrent exchange; denial/expiry; cookie and native bearer; revocation; restart; migration; recovery; rate limits.',
);
