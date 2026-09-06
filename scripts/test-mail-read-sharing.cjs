// Real tRPC router + synthetic providers. No network or mailbox changes.
const fs = require('node:fs'),
  vm = require('node:vm'),
  ts = require('typescript'),
  assert = require('node:assert/strict');
const req = require('node:module').createRequire(
  require('node:path').resolve('apps/server/package.json'),
);
function evaluate(file, globals) {
  const ast = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const source = ast.statements
    .filter((n) => !ts.isImportDeclaration(n))
    .map((n) => n.getText(ast))
    .join('\n');
  const context = vm.createContext({
    exports: {},
    console,
    setTimeout,
    clearTimeout,
    TextEncoder,
    crypto: require('node:crypto').webcrypto,
    ...globals,
  });
  vm.runInContext(
    ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }),
    context,
  );
  return context.exports;
}
(async () => {
  const { z } = req('zod'),
    { initTRPC, TRPCError } = req('@trpc/server'),
    superjson = (await import(req.resolve('superjson'))).default;
  const sharing = evaluate('apps/server/src/lib/single-flight.ts', {}),
    ids = evaluate('apps/server/src/lib/mailboxes/ids.ts', {}),
    schemas = evaluate('apps/server/src/lib/schemas.ts', { z });
  let reads = 0,
    metadata = 0,
    cached = null,
    release,
    providerError;
  const headers = new Headers();
  const getZeroDB = async () => ({ findManyConnections: async () => [] });
  const imapBridge = async (owner, action) => {
    if (action === 'accounts.list') {
      metadata++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return owner === 'owner' ? [{ id: 'a', email: 'synthetic@example.invalid' }] : [];
    }
    assert.equal(action, 'mail.get');
    reads++;
    if (providerError) throw providerError;
    await new Promise((resolve) => {
      release = resolve;
    });
    const message = {
      id: 'm',
      threadId: 'm',
      attachments: [
        {
          filename: 'test.txt',
          body: 'dGVzdA==',
          headers: [],
          mimeType: 'text/plain',
          size: 4,
          attachmentId: '0',
        },
      ],
      tags: [],
      sender: { email: 'synthetic@example.invalid' },
    };
    return { messages: [message], latest: message, labels: [], hasUnread: false, totalReplies: 1 };
  };
  const accounts = evaluate('apps/server/src/lib/mailboxes/accounts.ts', {
    ...sharing,
    getZeroDB,
    imapBridge,
    TRPCError,
    env: { IMAP_BRIDGE_URL: 'http://synthetic' },
  });
  const routers = evaluate('apps/server/src/trpc/routes/mailboxes.ts', {
    ...sharing,
    ...ids,
    ...schemas,
    ...accounts,
    z,
    initTRPC,
    TRPCError,
    superjson,
    getZeroDB,
    imapBridge,
    syncEnabled: () => false,
    cachedBody: async () => ({ body: cached, version: '1' }),
    storeBody: async (_owner, _account, _id, _version, value) => {
      cached = value;
    },
    syncSettingsSchema: z.object({}),
    manualCategorySchema: z.enum(['primary', 'transactions', 'updates', 'promotions']),
  });
  const caller = routers.unifiedMailRouter.createCaller({
    sessionUser: { id: 'owner' },
    c: { executionCtx: { waitUntil() {} }, header: (key, value) => headers.set(key, value) },
  });
  const id = ids.mailboxId('a', 'm');
  const tasks = [
    caller.get({ id }),
    caller.get({ id }),
    caller.getMessageAttachments({ messageId: id }),
    caller.get({ id }),
  ];
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(reads, 1, 'body and attachments must share one IMAP read');
  assert.ok(metadata <= 2, 'ownership metadata reads are shared');
  release();
  const results = await Promise.all(tasks);
  assert.equal(results[2][0].filename, 'test.txt');
  await caller.getMessageAttachments({ messageId: id });
  assert.equal(reads, 1, 'attachments reuse the cached body');
  const foreign = routers.unifiedMailRouter.createCaller({
    sessionUser: { id: 'foreign' },
    c: { executionCtx: { waitUntil() {} }, header: (key, value) => headers.set(key, value) },
  });
  await assert.rejects(foreign.get({ id }));
  assert.equal(reads, 1, 'foreign users cannot access cached/shared data');
  cached = null;
  for (const [message, wait] of [
    ['BUSY: Too many concurrent requests', '5'],
    ['RATE_LIMIT: Too many requests', '60'],
  ]) {
    providerError = new TRPCError({ code: 'TOO_MANY_REQUESTS', message });
    await assert.rejects(caller.get({ id }), { code: 'TOO_MANY_REQUESTS' });
    assert.equal(headers.get('Retry-After'), wait);
  }
  // Verify the real HTTP adapter preserves Retry-After for the browser client.
  const { Hono } = req('hono');
  const { trpcServer } = req('@hono/trpc-server');
  const { createTRPCClient, httpBatchLink } = require('node:module').createRequire(
    require('node:path').resolve('apps/mail/package.json'),
  )('@trpc/client');
  const app = new Hono().use(
    '/api/trpc/*',
    trpcServer({
      endpoint: '/api/trpc',
      router: routers.unifiedMailRouter,
      allowMethodOverride: true,
      createContext: (_, c) => ({ sessionUser: { id: 'owner' }, c }),
    }),
  );
  const client = createTRPCClient({
    links: [
      httpBatchLink({
        url: 'http://synthetic/api/trpc',
        transformer: superjson,
        methodOverride: 'POST',
        fetch: (url, options) => app.request(url, options),
      }),
    ],
  });
  await assert.rejects(client.get.query({ id }), (error) => {
    assert.equal(error.data.code, 'TOO_MANY_REQUESTS');
    assert.equal(error.meta.response.headers.get('Retry-After'), '60');
    return true;
  });
  console.log(
    'PASS: real router shares simultaneous body/attachment reads, reuses cached attachments, preserves ownership checks, and sends Retry-After through the HTTP adapter. Providers mocked.',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
