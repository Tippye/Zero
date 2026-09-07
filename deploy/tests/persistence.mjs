import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { pairingTestLogin, testComposeArgs } from './pairing-helper.mjs';

// This test restarts only the explicitly named acceptance project.
const origin = process.env.ZERO_TEST_URL || 'http://localhost:18080';
const login = await pairingTestLogin(origin);
assert.equal(login.status, 200);
// Exclude the signed session-data cookie, so this checks persisted server-side sessions.
const cookie = login.headers
  .getSetCookie()
  .filter((value) => value.split('=')[0].endsWith('session_token'))
  .map((value) => value.split(';')[0])
  .join('; ');
assert.ok(cookie);
const headers = { cookie, origin, 'content-type': 'application/json' };
async function settings() {
  const response = await fetch(origin + '/api/trpc/settings.get', { headers });
  assert.equal(response.status, 200);
  return (await response.json()).result.data.json.settings;
}
async function save(value) {
  const response = await fetch(origin + '/api/trpc/settings.save', {
    method: 'POST',
    headers,
    body: JSON.stringify({ json: { zeroSignature: value } }),
  });
  assert.equal(response.status, 200);
}
const before = await settings();
const sessionBefore = await (await fetch(origin + '/api/auth/get-session', { headers })).json();
try {
  await save(!before.zeroSignature);
  const result = spawnSync(
    'docker',
    [
      ...testComposeArgs(),
      'restart',
      'db',
      'redis',
      'redis-http',
      'api',
      ...(process.env.ZERO_TEST_PROJECT === 'zero-pairing-test' ? [] : ['imap-bridge', 'mail-sync']),
      'web',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  let ready = false;
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      const response = await fetch(origin + '/api/auth/get-session', { headers });
      const session = response.ok && (await response.json());
      if (session?.user?.id === sessionBefore.user.id) {
        ready = true;
        break;
      }
    } catch {
      /* Dependencies are restarting. */
    }
    await delay(1000);
  }
  assert.ok(ready, 'existing session did not survive restart');
  assert.equal((await settings()).zeroSignature, !before.zeroSignature);
  console.log(
    'PASS container restart: existing server-side session, shared account and saved settings persist',
  );
} finally {
  await save(before.zeroSignature);
}
