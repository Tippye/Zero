// Run from repository root with DATABASE_URL. Only an isolated temporary schema is changed.
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
  const context = vm.createContext({
    exports: {},
    console,
    TextEncoder,
    Date,
    JSON,
    crypto: require('node:crypto').webcrypto,
    ...globals,
  });
  vm.runInContext(
    ts.transpile(src, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }),
    context,
  );
  return context.exports;
}
(async () => {
  const url = process.env.DATABASE_URL;
  assert.ok(url);
  const schema = 'translation_check_' + Date.now();
  const admin = postgres(url, { max: 1, onnotice() {} });
  await admin.unsafe('CREATE SCHEMA ' + schema);
  const scoped = (_url, options = {}) =>
    postgres(url, { ...options, onnotice() {}, connection: { search_path: schema } });
  const sql = scoped(url, { max: 1 });
  try {
    await sql`CREATE TABLE mail0_user(id text PRIMARY KEY)`;
    await sql.unsafe(fs.readFileSync('integrations/mail-sync/schema.sql', 'utf8'));
    await sql`INSERT INTO mail0_user VALUES('owner'),('foreign')`;
    const cache = evaluate('apps/server/src/lib/mailboxes/cache.ts', {
      postgres: scoped,
      env: { MAIL_SYNC_ENABLED: 'true', HYPERDRIVE: { connectionString: url } },
      z,
      TRPCError,
    });
    const translations = evaluate('apps/server/src/lib/mailboxes/translations.ts', {
      withDb: cache.withDb,
    });
    const hash = await translations.translationSourceHash('Subject', '<p>Hello</p>');
    const key = { owner: 'owner', account: 'a', thread: 't', message: 'm', sourceHash: hash };
    assert.equal(await translations.getTranslation(key), null);
    const before = Date.now();
    const saved = await translations.saveTranslation(key, 'zh-CN', {
      html: '<p>你好</p>',
      subject: '主题',
    });
    assert.equal(saved.html, '<p>你好</p>');
    assert.ok(saved.expiresAt >= before + 90 * 86400000 - 1000);
    assert.equal(
      (await translations.getTranslation(key)).html,
      saved.html,
      'reopening returns stored translation',
    );
    assert.equal(await translations.getTranslation({ ...key, owner: 'foreign' }), null);
    assert.equal(await translations.getTranslation({ ...key, account: 'b' }), null);
    assert.equal(await translations.getTranslation({ ...key, message: 'other' }), null);
    assert.equal(await translations.getTranslation({ ...key, sourceHash: 'changed' }), null);
    assert.equal(await translations.getTranslation(key, 'ja'), null);
    await translations.saveTranslation(key, 'ja', { html: '<p>こんにちは</p>', subject: '件名' });
    await translations.getTranslation(key, 'zh-CN');
    assert.equal(
      (await translations.getTranslation(key)).language,
      'zh-CN',
      'reusing a cached language preserves that selection',
    );
    assert.equal(
      (await translations.getTranslation(key, 'zh-CN')).expiresAt,
      saved.expiresAt,
      'switching does not extend cache lifetime',
    );
    await sql`UPDATE mail0_mail_translations SET created_at=now()-interval '8 days'`;
    assert.ok(
      await translations.getTranslation(key),
      '90-day setting retains an eight-day-old translation',
    );
    await cache.saveSyncSettings('owner', {
      max_messages: 500,
      max_age_days: 7,
      body_budget_mb: 50,
      interval_seconds: 120,
    });
    assert.equal(
      (await sql`SELECT * FROM mail0_mail_translations`).length,
      0,
      'shortening retention physically deletes expired translations',
    );
    await translations.saveTranslation(key, 'zh-CN', { html: '<p>新翻译</p>', subject: '主题' });
    await sql`UPDATE mail0_mail_translations SET created_at=now()-interval '7 days'`;
    assert.equal(
      await translations.getTranslation(key),
      null,
      'expired translation is never returned',
    );
    assert.equal((await sql`SELECT * FROM mail0_mail_translations`).length, 0);
    console.log(
      'PASS: persistent translation cache, owner/mailbox/message/language/source isolation, default TTL, settings changes and physical expiry deletion. No AI calls.',
    );
  } finally {
    await sql.end();
    await admin.unsafe('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
