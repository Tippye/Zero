// Synthetic stack only. No mailbox, model, production cookie or email content.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const base = 'http://localhost:19180';
const rounds = Number(process.env.ZERO_LOAD_ROUNDS || 4);
const count = Number(process.env.ZERO_LOAD_COUNT || 250);
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const post = (action, body) =>
  fetch(`${base}/api/pairing/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify(body),
  });
const started = await post('start', { deviceName: 'Synthetic resource probe', mode: 'cookie' });
assert.equal(started.status, 200);
const pairing = await started.json();
docker(
  'exec',
  'zero-pairing-test-api-1',
  'node',
  'pairing.mjs',
  'approve',
  pairing.userCode || pairing.code,
  '--yes',
);
const exchanged = await post('exchange', {
  requestId: pairing.requestId,
  deviceSecret: pairing.deviceSecret,
});
assert.equal(exchanged.status, 200);
const cookie = exchanged.headers
  .getSetCookie()
  .map((s) => s.split(';')[0])
  .join('; ');
const sample = () => {
  const heap =
    process.env.ZERO_LOAD_HEAP === 'true'
      ? JSON.parse(docker('exec', 'zero-pairing-test-api-1', 'node', '/tmp/heap-probe.mjs'))
      : undefined;
  const memory = docker(
    'exec',
    'zero-pairing-test-api-1',
    'node',
    '-e',
    `const fs=require('fs');let kb=0;for(const id of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){try{if(fs.readFileSync('/proc/'+id+'/comm','utf8').trim()==='workerd')kb+=Number(fs.readFileSync('/proc/'+id+'/status','utf8').match(/VmRSS:\\s+(\\d+)/)?.[1]||0)}catch{}}console.log(kb)`,
  );
  const connections = docker(
    'exec',
    'zero-pairing-test-db-1',
    'psql',
    '-U',
    'zero',
    '-d',
    'zero',
    '-Atc',
    "SELECT count(*) FROM pg_stat_activity WHERE datname='zero'",
  );
  console.log(
    JSON.stringify({
      requests: completed,
      workerdRssMiB: Math.round(Number(memory) / 1024),
      dbConnections: Number(connections),
      heap,
    }),
  );
};
let completed = 0;
sample();
for (let round = 0; round < rounds; round++) {
  for (let i = 0; i < count; i++) {
    const response = await fetch(`${base}/api/desktop/events?after=0`, {
      headers: { cookie },
      signal: AbortSignal.timeout(10000),
    });
    if (response.status !== 200) {
      sample();
      throw new Error(
        `Synthetic request ${completed + 1}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`,
      );
    }
    await response.arrayBuffer();
    completed++;
  }
  sample();
}
