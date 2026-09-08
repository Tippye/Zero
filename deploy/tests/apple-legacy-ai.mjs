import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

// Existing Web AI protocol, using a signed native bearer in the isolated Compose stack.
// No live backend or provider credentials are used. Generation probes require AI disabled.
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
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const sql = (query) =>
  run('db', ['psql', '-U', 'zero', '-d', 'zero', '-At', '-v', 'ON_ERROR_STOP=1'], query).trim();
const literal = (value) => "'" + value.replace(/'/g, "''") + "'";
let token;
async function request(path, input, credential = token) {
  return fetch(origin + '/api/' + path, {
    method: input === undefined ? 'GET' : 'POST',
    headers: {
      ...(input === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(credential ? { Authorization: 'Bearer ' + credential } : {}),
      Origin: origin,
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
}
const report = { origin, checkedAt: new Date().toISOString(), checks: [], envelopes: {} };
async function trpc(name, method = 'GET', input, credential = token, expected = 200) {
  const encoded = input === undefined ? undefined : { json: input };
  const response = await request(
    'trpc/' +
      name +
      (method === 'GET' && encoded !== undefined
        ? '?input=' + encodeURIComponent(JSON.stringify(encoded))
        : ''),
    method === 'POST' ? encoded || { json: null } : undefined,
    credential,
  );
  const value = await response.json();
  assert.equal(response.status, expected, name + ' status');
  if (expected === 200) {
    assert.ok(value.result && Object.hasOwn(value.result.data, 'json'), name + ' SuperJSON result');
    return value.result.data.json;
  }
  assert.equal(typeof value.error.json.code, 'number');
  assert.equal(value.error.json.data.httpStatus, expected);
  assert.equal(typeof value.error.json.data.code, 'string');
  return value.error.json;
}
async function check(name, action) {
  await action();
  report.checks.push({ name, passed: true });
}
const nativeId = 'legacy-ai-' + randomUUID();
const threadId = 'mbx.native-test-account.' + nativeId;
let owner;
try {
  for (const [name, credential] of [
    ['missing', null],
    ['forged', 'invalid-legacy-fixture'],
  ]) {
    await check(name + '-bearer-rejected', async () => {
      const error = await trpc('llm.list', 'GET', undefined, credential, 401);
      assert.equal(error.data.code, 'UNAUTHORIZED');
    });
  }
  sql('DELETE FROM mail0_pairing_rate;');
  const pending = await (
    await request('pairing/start', { deviceName: 'Legacy AI protocol fixture', mode: 'native' })
  ).json();
  assert.ok(pending.userCode);
  run('api', ['node', 'pairing.mjs', 'approve', pending.userCode, '--yes']);
  const exchange = await request('pairing/exchange', {
    requestId: pending.requestId,
    deviceSecret: pending.deviceSecret,
  });
  assert.equal(exchange.status, 200);
  ({ token } = await exchange.json());
  assert.ok(token);
  owner = sql('SELECT user_id FROM mail0_pairing_owner WHERE id=1;');
  let overview;
  await check('signed-native-bearer-llm-list-get', async () => {
    overview = await trpc('llm.list');
    assert.equal(
      overview.ready,
      false,
      'Generation probes require an unconfigured isolated provider',
    );
    assert.ok(Array.isArray(overview.profiles));
    assert.ok(
      !overview.profiles.some((profile) => 'apiKey' in profile || 'encryptedKey' in profile),
    );
    report.envelopes.status = { result: { data: { json: overview } } };
  });
  await check('query-post-override-supported', async () => {
    assert.deepEqual(await trpc('llm.list', 'POST'), overview);
  });
  const thread = await trpc('mail.get', 'GET', { id: threadId });
  const message = thread.messages[0];
  assert.equal(message.id, threadId);
  const identity = { threadId, messageId: message.id };
  await check('translation-miss-is-json-null', async () => {
    assert.equal(await trpc('ai.translation', 'GET', identity), null);
  });
  const sourceHash = createHash('sha256')
    .update(JSON.stringify([message.subject || '', message.decodedBody || '']))
    .digest('hex');
  sql(`INSERT INTO mail0_mail_translations(user_id,account_id,thread_id,message_id,language,source_hash,html,subject)
    VALUES(${literal(owner)},'native-test-account',${literal(nativeId)},${literal(nativeId)},'zh-CN',${literal(sourceHash)},'<p>你好 &amp; 欢迎</p><p>第二段</p>','缓存翻译测试');`);
  let translation;
  await check('translation-query-preserves-html-cache-and-expiry', async () => {
    translation = await trpc('ai.translation', 'GET', identity);
    assert.equal(translation.subject, '缓存翻译测试');
    assert.equal(translation.html, '<p>你好 &amp; 欢迎</p><p>第二段</p>');
    assert.equal(translation.language, 'zh-CN');
    assert.ok(translation.expiresAt > Date.now());
    assert.equal(
      translation.text,
      undefined,
      'Web translation requires native plain-text conversion',
    );
    report.envelopes.translation = { result: { data: { json: translation } } };
  });
  const reader = { ...identity, action: 'translate', language: 'zh-CN', question: '', history: [] };
  await check('reader-post-uses-existing-translation-cache', async () => {
    const result = await trpc('ai.read', 'POST', reader);
    assert.equal(result.text, '');
    assert.deepEqual(result.translation, translation);
    report.envelopes.reader = { result: { data: { json: result } } };
  });
  await check('foreign-mailbox-denied-before-provider', async () => {
    const error = await trpc(
      'ai.read',
      'POST',
      { ...reader, threadId: 'mbx.foreign-account.message' },
      token,
      404,
    );
    assert.equal(error.data.code, 'NOT_FOUND');
  });
  await check('foreign-message-denied-before-provider', async () => {
    const error = await trpc(
      'ai.read',
      'POST',
      { ...reader, messageId: 'mbx.native-test-account.absent' },
      token,
      404,
    );
    assert.equal(error.message, 'MAIL_AI_MESSAGE_NOT_FOUND');
  });
  for (const action of ['summary', 'ask']) {
    await check(action + '-routes-to-owner-provider', async () => {
      const error = await trpc(
        'ai.read',
        'POST',
        { ...reader, action, question: 'What is this fixture?' },
        token,
        412,
      );
      assert.equal(error.message, 'LLM_NOT_CONFIGURED: /settings/llm');
      assert.equal(error.data.code, 'PRECONDITION_FAILED');
      report.envelopes.providerError = {
        error: {
          json: {
            message: error.message,
            code: error.code,
            data: {
              code: error.data.code,
              httpStatus: error.data.httpStatus,
              path: error.data.path,
            },
          },
        },
      };
    });
  }
  await check('compose-routes-without-imap-account-or-send', async () => {
    const error = await trpc(
      'imap.generate',
      'POST',
      { task: 'compose', instructions: 'Draft a synthetic greeting.', consent: true },
      token,
      412,
    );
    assert.equal(error.message, 'LLM_NOT_CONFIGURED: /settings/llm');
  });
  await check('compose-requires-consent', async () => {
    const error = await trpc(
      'imap.generate',
      'POST',
      { task: 'compose', instructions: 'Draft a synthetic greeting.', consent: false },
      token,
      400,
    );
    assert.equal(error.data.code, 'BAD_REQUEST');
  });
  await check('reader-validates-input', async () => {
    const error = await trpc(
      'ai.read',
      'POST',
      { ...reader, action: 'ask', question: '' },
      token,
      400,
    );
    assert.equal(error.data.code, 'BAD_REQUEST');
  });
} finally {
  if (owner)
    sql(
      `DELETE FROM mail0_mail_translations WHERE user_id=${literal(owner)} AND account_id='native-test-account' AND thread_id=${literal(nativeId)};`,
    );
  if (token) {
    const devices = await (await request('pairing/devices')).json();
    const current = devices.devices.find((device) => device.current);
    assert.ok(current);
    assert.equal((await request('pairing/revoke', { sessionId: current.id })).status, 200);
  }
}
const directory = 'native/apple/.derived/validation/backend';
await mkdir(directory, { recursive: true });
await writeFile(directory + '/legacy-ai-wire.json', JSON.stringify(report, null, 2) + '\n');
console.log(
  'Legacy Web AI protocol: ' +
    report.checks.length +
    ' signed-bearer, SuperJSON, shared translation, ownership, validation and provider-routing checks passed. No AI provider was called.',
);
