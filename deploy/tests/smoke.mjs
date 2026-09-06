import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const config = Object.fromEntries(
  (await readFile(new URL('../.env', import.meta.url), 'utf8'))
    .split('\n')
    .filter((x) => x.includes('=') && !x.startsWith('#'))
    .map((x) => {
      const i = x.indexOf('=');
      return [x.slice(0, i), x.slice(i + 1)];
    }),
);
const origin = process.env.ZERO_TEST_URL || 'http://localhost:18080';
async function login() {
  const response = await fetch(origin + '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email: config.ADMIN_EMAIL, password: config.ADMIN_PASSWORD }),
  });
  assert.equal(response.status, 200, 'password login failed');
  const cookie = response.headers
    .getSetCookie()
    .map((s) => s.split(';')[0])
    .join('; ');
  assert.ok(cookie, 'session cookie missing');
  if (origin.startsWith('https:'))
    assert.ok(
      response.headers.getSetCookie().some((s) => s.includes('Secure')),
      'HTTPS cookie must be Secure',
    );
  else
    assert.ok(
      response.headers.getSetCookie().every((s) => !s.includes('Secure')),
      'HTTP login cookie cannot require HTTPS',
    );
  return cookie;
}
const unauth = await fetch(origin + '/api/desktop/events');
assert.equal(unauth.status, 401);
const signup = await fetch(origin + '/api/auth/sign-up/email', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin },
  body: JSON.stringify({
    email: 'nobody@example.invalid',
    password: 'synthetic-password',
    name: 'test',
  }),
});
assert.ok(signup.status >= 400, 'public registration must be disabled');
const first = await login(),
  second = await login();
const who = async (cookie) =>
  await (await fetch(origin + '/api/auth/get-session', { headers: { cookie } })).json();
const one = await who(first),
  two = await who(second);
assert.equal(one.user.id, two.user.id, 'devices must share account identity');
const events = await fetch(origin + '/api/desktop/events', { headers: { cookie: first } });
assert.equal(events.status, 200);
const head = await events.json();
assert.equal(head.owner, one.user.id);
assert.deepEqual(head.events, []);
const invalid = await fetch(origin + '/api/desktop/events?after=invalid', {
  headers: { cookie: first },
});
assert.equal(invalid.status, 400);
const index = await fetch(origin + '/mail/inbox');
assert.equal(index.status, 200);
assert.ok((await index.text()).includes('runtime-config.js'));
console.log(
  `PASS ${new URL(origin).protocol} deployment: shared login identity, cookie flags, private notification feed, registration disabled, SPA routing`,
);
