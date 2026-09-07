import { approveTestCode } from './pairing-helper.mjs';
import assert from 'node:assert/strict';
const origin = 'https://localhost:19143';
process.env.ZERO_TEST_PROJECT = 'zero-pairing-test';
const post = (path, body) =>
  fetch(origin + '/api/pairing/' + path, {
    method: 'POST',
    headers: { origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const start = await post('start', { deviceName: 'HTTPS test' });
assert.equal(start.status, 200);
const request = await start.json();
assert.equal(new URL(request.verificationUri).origin, origin);
approveTestCode(request.userCode);
const result = await post('exchange', {
  requestId: request.requestId,
  deviceSecret: request.deviceSecret,
});
assert.equal(result.status, 200);
const all = result.headers.getSetCookie();
assert.ok(
  all.some(
    (c) =>
      c.startsWith('__Secure-zero-secure.session_token=') &&
      c.includes('Secure') &&
      c.includes('HttpOnly'),
  ),
);
const cookie = all.map((c) => c.split(';')[0]).join('; ');
const session = await (
  await fetch(origin + '/api/auth/get-session', { headers: { cookie } })
).json();
assert.ok(session?.user?.id);
const http = await (
  await fetch('http://localhost:19180/api/auth/get-session', { headers: { cookie } })
).json();
assert.equal(http, null, 'HTTPS cookie cannot authenticate HTTP endpoint');
console.log(
  'PASS HTTPS: trusted test certificate, HTTPS QR origin, Secure/HttpOnly cookie, authenticated session, HTTP cookie isolation.',
);
