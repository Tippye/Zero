// Exercises the real cache SQL in an isolated temporary schema; no provider access or real mail changes.
const fs = require('node:fs'),
  vm = require('node:vm'),
  ts = require('typescript'),
  assert = require('node:assert/strict');
const req = require('node:module').createRequire(
  require('node:path').resolve('apps/server/package.json'),
);
const postgres = req('postgres'),
  { z } = req('zod'),
  { TRPCError } = req('@trpc/server');
function evaluate(file, globals) {
  const ast = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const src = ast.statements
    .filter((n) => !ts.isImportDeclaration(n))
    .map((n) => n.getText(ast))
    .join('\n');
  const ctx = vm.createContext({ exports: {}, console, TextEncoder, Date, JSON, ...globals });
  vm.runInContext(
    ts.transpile(src, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }),
    ctx,
  );
  return ctx.exports;
}
(async () => {
  const schema = 'classify_check_' + Date.now(),
    url = process.env.DATABASE_URL;
  assert.ok(url);
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe('CREATE SCHEMA ' + schema);
  const scoped = (_url, opts = {}) =>
      postgres(url, { ...opts, onnotice: () => {}, connection: { search_path: schema } }),
    sql = scoped(url, { max: 1 });
  try {
    await sql`CREATE TABLE mail0_user(id text PRIMARY KEY)`;
    await sql.unsafe(fs.readFileSync('integrations/mail-sync/schema.sql', 'utf8'));
    await sql`CREATE TABLE mail0_user_settings(user_id text PRIMARY KEY,settings jsonb NOT NULL)`;
    await sql`CREATE TABLE mail0_user_llm_settings(user_id text PRIMARY KEY,profiles jsonb NOT NULL,active_id text)`;
    await sql`INSERT INTO mail0_user VALUES('owner'),('foreign')`;
    await sql`INSERT INTO mail0_sync_accounts(user_id,account_id,provider,email,name) VALUES('owner','a','google','a@example.invalid','A'),('foreign','b','imap','b@example.invalid','B')`;
    const { upsert } = await import('../src/store.mjs'),
      { imapEntry } = await import('../src/model.mjs');
    const { classifyAccount, classificationProfile } = await import('../src/classify.mjs');
    const identifiers = evaluate('apps/server/src/lib/mailboxes/ids.ts', {});
    const cache = evaluate('apps/server/src/lib/mailboxes/cache.ts', {
      postgres: scoped,
      env: { MAIL_SYNC_ENABLED: 'true', HYPERDRIVE: { connectionString: url } },
      z,
      TRPCError,
      ...identifiers,
    });
    const account = { user_id: 'owner', account_id: 'a' },
      publicAccount = { id: 'a', email: 'a@example.invalid', providerId: 'google' };
    const row = imapEntry('a', 'inbox', {
      id: 'same-id',
      subject: 'Synthetic receipt',
      receivedOn: new Date().toISOString(),
    });
    await upsert(sql, account, [row]);
    await upsert(sql, { user_id: 'foreign', account_id: 'b' }, [row]);
    const config = {
      OPENAI_API_KEY: 'synthetic-key',
      OPENAI_URL: 'https://example.invalid/v1',
      OPENAI_MODEL: 'synthetic-model',
    };
    let requests = 0;
    const request = async () => {
      requests++;
      return Response.json({
        choices: [{ message: { content: '{"results":[{"id":0,"category":"transactions"}]}' } }],
      });
    };
    await classifyAccount(sql, config, account, request);
    assert.equal(requests, 1);
    const input = {
      folder: 'inbox',
      q: '',
      labelIds: ['ZERO_CATEGORY_TRANSACTIONS'],
      cursor: '',
      maxResults: 20,
    };
    assert.equal((await cache.cachedThreads('owner', [publicAccount], input)).threads.length, 1);
    assert.equal(
      (await cache.cachedThreads('foreign', [{ ...publicAccount, id: 'b' }], input)).threads.length,
      0,
    );
    await cache.patchCachedLabels('owner', publicAccount, ['same-id'], ['IMPORTANT'], []);
    await classifyAccount(sql, config, account, request);
    assert.equal(requests, 1, 'flag changes do not reclassify');
    assert.equal(
      (
        await cache.cachedThreads('owner', [publicAccount], {
          ...input,
          labelIds: [...input.labelIds, 'IMPORTANT'],
        })
      ).threads.length,
      1,
    );
    await upsert(sql, account, [row]);
    assert.equal(
      (await cache.cachedThreads('owner', [publicAccount], input)).threads.length,
      1,
      'sync preserves category',
    );
    await sql`UPDATE mail0_cached_mail SET search_text='changed' WHERE user_id='owner'`;
    assert.equal(
      (await cache.cachedThreads('owner', [publicAccount], input)).threads.length,
      0,
      'changed content waits for fresh category',
    );
    await classifyAccount(sql, config, account, async () => {
      await sql`UPDATE mail0_cached_mail SET search_text='changed again' WHERE user_id='owner'`;
      return request();
    });
    assert.equal(
      (await cache.cachedThreads('owner', [publicAccount], input)).threads.length,
      0,
      'stale in-flight result discarded',
    );
    await classifyAccount(sql, config, account, async () =>
      Response.json({
        choices: [{ message: { content: '{"results":[{"id":12,"category":"promotions"}]}' } }],
      }),
    );
    assert.equal(
      (await cache.syncStatus('owner', [publicAccount])).accounts[0].classificationError,
      'INVALID_RESPONSE',
    );

    // Manual choices survive changed content, refreshes, and eviction/reinsertion.
    await cache.moveCachedCategory('owner', 'a', 'same-id', 'primary');
    const primary = { ...input, labelIds: ['ZERO_CATEGORY_PRIMARY'] };
    assert.equal((await cache.cachedThreads('owner', [publicAccount], primary)).threads.length, 1);
    assert.equal((await cache.cachedThreads('owner', [publicAccount], input)).threads.length, 0);
    await assert.rejects(cache.moveCachedCategory('foreign', 'a', 'same-id', 'updates'), {
      code: 'NOT_FOUND',
    });
    await sql`UPDATE mail0_cached_mail SET search_text='new subject' WHERE user_id='owner'`;
    await classifyAccount(sql, config, account, () => {
      throw new Error('Manual choice should not be classified');
    });
    assert.equal((await cache.cachedCategory('owner', 'a', 'same-id')).category, 'primary');
    assert.equal((await cache.syncStatus('owner', [publicAccount])).accounts[0].classifiedCount, 1);
    await sql`DELETE FROM mail0_cached_mail WHERE user_id='owner'`;
    await upsert(sql, account, [row]);
    assert.equal((await cache.cachedThreads('owner', [publicAccount], primary)).threads.length, 1);
    await cache.moveCachedCategory('owner', 'a', 'same-id', 'updates');
    assert.equal((await cache.cachedCategory('owner', 'a', 'same-id')).category, 'updates');
    assert.equal(
      (await sql`SELECT * FROM mail0_category_feedback WHERE user_id='owner'`).length,
      1,
    );
    const { categoryPreferences } = await import('../src/classify.mjs');
    assert.equal((await categoryPreferences(sql, 'owner', 'a')).length, 0);
    await sql`INSERT INTO mail0_user_settings VALUES('owner','{"aiCategoryLearning":true}'::jsonb)`;
    assert.equal((await categoryPreferences(sql, 'owner', 'a'))[0].category, 'updates');
    assert.equal((await categoryPreferences(sql, 'foreign', 'a')).length, 0);
    assert.equal((await categoryPreferences(sql, 'owner', 'b')).length, 0);
    await sql`UPDATE mail0_user_settings SET settings='{"aiCategoryLearning":false}'::jsonb WHERE user_id='owner'`;
  // Simulate a user moving a message while the classifier is waiting for its model.
    await sql`DELETE FROM mail0_category_feedback WHERE user_id='owner'`;
    await sql`UPDATE mail0_cached_mail SET ai_category=NULL WHERE user_id='owner'`;
    await classifyAccount(sql, config, account, async () => {
      await cache.moveCachedCategory('owner', 'a', 'same-id', 'promotions');
      return request();
    });
    assert.equal((await cache.cachedCategory('owner', 'a', 'same-id')).category, 'promotions');
    const [stored] = await sql`SELECT ai_category FROM mail0_cached_mail WHERE user_id='owner'`;
    assert.equal(stored.ai_category, 'promotions');
    await sql`UPDATE mail0_user_settings SET settings='{"aiCategoryLearning":false}'::jsonb WHERE user_id='owner'`;
    assert.equal((await categoryPreferences(sql, 'owner', 'a')).length, 0);
    console.log(
      'PASS: manual classification, owner isolation, cache eviction, sync refresh, latest preference, opt-in learning and in-flight manual override.',
    );
    await sql`INSERT INTO mail0_user_llm_settings VALUES('owner','[]'::jsonb,NULL)`;
    assert.equal(
      await classificationProfile(sql, config, 'owner'),
      null,
      'explicitly deactivated provider does not fall back to env',
    );
    const { webcrypto, createHash } = require('node:crypto');
    const key = await webcrypto.subtle.importKey(
      'raw',
      createHash('sha256').update('zero-llm-v1:synthetic-secret').digest(),
      'AES-GCM',
      false,
      ['encrypt'],
    );
    const iv = webcrypto.getRandomValues(new Uint8Array(12)),
      encrypted = await webcrypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: Buffer.from('owner:profile') },
        key,
        Buffer.from('synthetic-profile-key'),
      );
    const profile = {
      id: 'profile',
      baseUrl: 'https://example.invalid/v1',
      model: 'large',
      miniModel: 'mini',
      encryptedKey:
        Buffer.from(iv).toString('base64') + '.' + Buffer.from(encrypted).toString('base64'),
    };
    await sql`UPDATE mail0_user_llm_settings SET profiles=${sql.json([profile])},active_id='profile' WHERE user_id='owner'`;
    const resolved = await classificationProfile(
      sql,
      { BETTER_AUTH_SECRET: 'synthetic-secret' },
      'owner',
    );
    assert.equal(resolved.model, 'mini');
    assert.equal(resolved.apiKey, 'synthetic-profile-key');
    await sql`INSERT INTO mail0_user_llm_settings VALUES('foreign',${sql.json([profile])},'profile')`;
    await assert.rejects(
      classificationProfile(sql, { BETTER_AUTH_SECRET: 'synthetic-secret' }, 'foreign'),
      { code: 'CONFIGURATION' },
    );
    console.log(
      'PASS: real SQL classification, owner isolation, category filtering, label combinations, sync persistence, no repeat classification, stale results, error status, explicit deactivation and encrypted active profile. Provider mocked.',
    );
  } finally {
    await sql.end();
    await admin.unsafe('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  }
})().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
