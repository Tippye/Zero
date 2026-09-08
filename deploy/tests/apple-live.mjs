import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Read-only acceptance against an existing deployment. Pairing approval happens separately.
// The session file is private JSON: { origin, token }. Never print it or mail contents.
const origin = new URL(process.env.ZERO_APPLE_ORIGIN || 'http://localhost:18080').origin;
const sessionFile = process.env.ZERO_APPLE_SESSION_FILE;
const session = sessionFile ? JSON.parse(await readFile(sessionFile, 'utf8')) : undefined;
if (session) {
  assert.equal(session.origin, origin, 'The paired session must belong to the tested origin');
  assert.equal(typeof session.token, 'string');
  assert.ok(session.token.length > 0);
}
const report = {
  origin,
  checkedAt: new Date().toISOString(),
  authenticated: !!session,
  checks: [],
};
async function check(name, run) {
  try {
    const details = await run();
    report.checks.push({ name, passed: true, ...details });
  } catch (error) {
    // Do not echo response bodies, which may contain private message data.
    report.checks.push({
      name,
      passed: false,
      ...(error instanceof NativeAPIError
        ? { httpStatus: error.status, errorCode: error.code }
        : {}),
    });
    process.exitCode = 1;
  }
}
async function request(path, input, token = session?.token) {
  const response = await fetch(origin + '/api/' + path, {
    method: input === undefined ? 'GET' : 'POST',
    headers: {
      ...(input === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  return response;
}
class NativeAPIError extends Error {
  constructor(status, code) {
    super('Native API check failed');
    this.status = status;
    this.code = code;
  }
}
async function native(operation, input = {}) {
  const response = await request('native/v1/' + operation, input);
  if (response.status !== 200) {
    const error = await response.json().catch(() => ({}));
    const code =
      typeof error.error === 'string' && /^[A-Za-z_]{1,60}$/.test(error.error)
        ? error.error
        : 'unavailable';
    throw new NativeAPIError(response.status, code);
  }
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  return response.json();
}
await check('server-compatibility', async () => {
  const response = await request('desktop/info', undefined, null);
  assert.equal(response.status, 200);
  const info = await response.json();
  assert.equal(info.server, 'zero');
  assert.equal(info.authentication?.type, 'pairing');
  assert.equal(info.authentication?.version, 1);
  return { apiVersion: info.apiVersion, notifications: info.notifications };
});
await check('native-rejects-missing-and-forged-bearer', async () => {
  for (const token of [null, 'invalid-apple-validation-token']) {
    const response = await request('native/v1/accounts', {}, token);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('cache-control') || '', /no-store/);
  }
});
if (session) {
  await check('paired-device-session', async () => {
    const response = await request('pairing/devices');
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.ok(value.devices.some((device) => device.current));
  });
  await check('native-mailboxes', async () => {
    const { accounts } = await native('accounts');
    assert.ok(Array.isArray(accounts));
    return {
      count: accounts.length,
      connected: accounts.filter((account) => account.connected).length,
    };
  });
  for (const folder of ['inbox', 'sent', 'draft', 'archive', 'spam', 'trash', 'starred']) {
    await check('native-folder-' + folder, async () => {
      const first = await native('threads', { folder, maxResults: 1 });
      assert.ok(Array.isArray(first.threads));
      assert.ok(first.threads.length <= 1);
      if (first.cursor) {
        const next = await native('threads', { folder, maxResults: 1, cursor: first.cursor });
        assert.ok(!next.threads.some((item) => item.id === first.threads[0]?.id));
      }
      if (first.threads.length && folder !== 'draft') {
        const thread = await native('thread', { id: first.threads[0].id });
        assert.equal(thread.id, first.threads[0].id);
        assert.ok(Array.isArray(thread.messages));
        for (const message of thread.messages) {
          assert.equal(typeof message.text, 'string');
          assert.ok(message.attachments.every((file) => !Object.hasOwn(file, 'body')));
        }
      }
      return {
        sampled: first.threads.length,
        paginated: !!first.cursor,
        warnings: first.warnings?.length || 0,
      };
    });
  }
  await check('native-search', async () => {
    const result = await native('threads', {
      q: 'subject:zero-apple-validation-no-match',
      maxResults: 1,
    });
    assert.ok(Array.isArray(result.threads));
  });
  await check('native-ai-status', async () => {
    const value = await native('ai-status');
    assert.equal(typeof value.ready, 'boolean');
    return { ready: value.ready };
  });
  await check('legacy-web-ai-status', async () => {
    // Older deployments already serve this Web procedure with the same signed bearer.
    // Inspect availability only; never probe generation or expose provider settings.
    const response = await request('trpc/llm.list');
    const envelope = await response.json();
    if (response.status !== 200) {
      const value = envelope.error?.json?.data?.code;
      const code =
        typeof value === 'string' && /^[A-Za-z_]{1,60}$/.test(value) ? value : 'unavailable';
      throw new NativeAPIError(response.status, code);
    }
    const value = envelope.result?.data?.json;
    assert.equal(typeof value?.ready, 'boolean');
    assert.ok(Array.isArray(value.profiles));
    return { ready: value.ready };
  });
  await check('notification-baseline', async () => {
    const response = await request('desktop/events');
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.ok(Array.isArray(value.events));
    assert.equal(
      value.events.length,
      0,
      'The initial notification baseline must not replay history',
    );
    assert.equal(typeof value.cursor, 'string');
    const nativeEvents = await native('events');
    assert.equal(nativeEvents.owner, value.owner);
    assert.deepEqual(nativeEvents.events, []);
    assert.equal(typeof nativeEvents.cursor, 'string');
  });
}
const output = process.env.ZERO_APPLE_REPORT || '/tmp/zero-apple-live-validation.json';
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
