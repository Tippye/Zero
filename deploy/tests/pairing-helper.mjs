import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

export function testComposeArgs() {
  const project = process.env.ZERO_TEST_PROJECT || 'zero-compose-test';
  assert.ok(
    ['zero-compose-test', 'zero-pairing-test'].includes(project),
    'Only isolated acceptance projects may approve test devices',
  );
  return project === 'zero-pairing-test'
    ? ['compose', '-f', 'deploy/tests/compose.pairing.yaml']
    : ['compose', '--env-file', 'deploy/.env', '-p', project, '-f', 'compose.yaml'];
}
export function approveTestCode(code) {
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const result = spawnSync(
    'docker',
    [...testComposeArgs(), 'exec', '-T', 'api', 'node', 'pairing.mjs', 'approve', code, '--yes'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
}
export async function pairingTestLogin(origin) {
  const url = new URL(origin);
  assert.ok(
    ['localhost', '127.0.0.1'].includes(url.hostname) &&
      ['18080', '18443', '19180'].includes(url.port),
    'Use an isolated acceptance URL',
  );
  const headers = { 'content-type': 'application/json', origin };
  const start = await fetch(origin + '/api/pairing/start', {
    method: 'POST',
    headers,
    body: JSON.stringify({ deviceName: 'Acceptance test', mode: 'cookie' }),
  });
  assert.equal(start.status, 200);
  const request = await start.json();
  approveTestCode(request.userCode);
  const response = await fetch(origin + '/api/pairing/exchange', {
    method: 'POST',
    headers,
    body: JSON.stringify({ requestId: request.requestId, deviceSecret: request.deviceSecret }),
  });
  assert.equal(response.status, 200, 'pairing login failed');
  return response;
}
