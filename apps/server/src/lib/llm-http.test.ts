import { isLocalLlmHost, llmRequestUrl, requestLlmJson, testLlmModel } from './llm-http';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const profile = {
  baseUrl: 'http://localhost:20128/v1',
  apiKey: 'synthetic-key',
  model: 'test-chat',
};

test('Docker LLM mapping preserves endpoint, port and existing direct deployments', () => {
  assert.equal(
    llmRequestUrl(`${profile.baseUrl}/models`, 'host.docker.internal'),
    'http://host.docker.internal:20128/v1/models',
  );
  assert.equal(llmRequestUrl(`${profile.baseUrl}/models`), `${profile.baseUrl}/models`);
  assert.equal(
    llmRequestUrl('https://api.example.test/v1/models', 'host.docker.internal'),
    'https://api.example.test/v1/models',
  );
});

test('list request uses mapped host and retains credentials only in headers', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'http://host.docker.internal:20128/v1/models');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-key');
    assert.equal(init?.redirect, 'manual');
    return Response.json({ data: [{ id: 'test-chat' }] });
  });
  assert.deepEqual(
    await requestLlmJson({ ...profile, path: 'models', loopbackHost: 'host.docker.internal' }),
    { data: [{ id: 'test-chat' }] },
  );
});

test('network, timeout, authentication, rate limit, invalid response and redirects remain distinct', async (t) => {
  const cases: Array<[() => Promise<Response>, string]> = [
    [
      async () => {
        throw new TypeError('fetch failed');
      },
      'LLM_NETWORK_FAILED',
    ],
    [
      async () => {
        throw new DOMException('timeout', 'TimeoutError');
      },
      'LLM_TIMEOUT',
    ],
    [
      async () => Response.json({ error: { message: profile.apiKey } }, { status: 401 }),
      'LLM_AUTH_FAILED',
    ],
    [async () => Response.json({}, { status: 403 }), 'LLM_ACCESS_DENIED'],
    [async () => Response.json({}, { status: 429 }), 'LLM_RATE_LIMITED'],
    [
      async () => Response.json({ error: { code: 'insufficient_quota' } }, { status: 429 }),
      'LLM_QUOTA_EXCEEDED',
    ],
    [async () => new Response('', { status: 302 }), 'LLM_REDIRECT_DISABLED'],
    [async () => new Response('<html>Login</html>'), 'LLM_INVALID_RESPONSE'],
    [async () => Response.json({}, { status: 404 }), 'LLM_MODELS_UNSUPPORTED'],
  ];
  for (const [fetcher, message] of cases) {
    const mock = t.mock.method(globalThis, 'fetch', fetcher);
    await assert.rejects(requestLlmJson({ ...profile, path: 'models' }), { message });
    mock.mock.restore();
  }
});

test('testing sends a bounded synthetic chat and supports legacy token limits', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.messages, [{ role: 'user', content: 'Reply with exactly OK.' }]);
    assert.equal(body.model, profile.model);
    assert.equal(body.stream, false);
    if (calls === 1) {
      assert.equal(body.max_completion_tokens, 256);
      return Response.json({ error: { param: 'max_completion_tokens' } }, { status: 400 });
    }
    assert.equal(body.max_tokens, 256);
    return Response.json({ choices: [{ message: { content: 'OK' } }] });
  });
  const result = await testLlmModel(profile);
  assert.equal(result.success, true);
  assert.equal(result.model, profile.model);
  assert.equal(calls, 2);
  assert.ok(result.latencyMs >= 0);
});

test('an empty model response does not produce a false positive', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ choices: [{ message: { content: '' } }] }),
  );
  await assert.rejects(testLlmModel(profile), { message: 'LLM_EMPTY_RESPONSE' });
});

test('local HTTP supports private LAN ranges and Docker host names consistently', async () => {
  const { isLocalLlmHost: syncHost } = await import(
    '../../../../integrations/mail-sync/src/classify.mjs'
  );
  for (const hostname of [
    'localhost',
    '127.0.0.1',
    'host.docker.internal',
    '10.2.3.4',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.20',
    '[fd00::1]',
  ]) {
    assert.equal(isLocalLlmHost(hostname), true, hostname);
    assert.equal(syncHost(hostname), true, hostname);
  }
  for (const hostname of [
    'api.example.test',
    '172.15.0.1',
    '172.32.0.1',
    '192.169.1.20',
    '169.254.169.254',
  ]) {
    assert.equal(isLocalLlmHost(hostname), false, hostname);
    assert.equal(syncHost(hostname), false, hostname);
  }
  assert.equal(
    llmRequestUrl('http://192.168.1.20:8080/v1/models', 'host.docker.internal'),
    'http://192.168.1.20:8080/v1/models',
  );
});
