import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const folder = process.env.MIGRATIONS_DIR || '/app/migrations';
try {
  await sql`SELECT pg_advisory_lock(20260906, 2)`;
  await sql`CREATE SCHEMA IF NOT EXISTS drizzle`;
  await sql`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`;
  const journal = JSON.parse(await readFile(`${folder}/meta/_journal.json`, 'utf8'));
  for (const migration of journal.entries) {
    const [last] =
      await sql`SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`;
    if (last && Number(last.created_at) >= migration.when) continue;
    const source = await readFile(`${folder}/${migration.tag}.sql`, 'utf8');
    await sql.begin(async (tx) => {
      for (const statement of source.split('--> statement-breakpoint'))
        if (statement.trim()) await tx.unsafe(statement);
      await tx`INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES(${createHash('sha256').update(source).digest('hex')}, ${migration.when})`;
    });
    console.log(`Applied ${migration.tag}`);
  }
  await sql.unsafe(await readFile(process.env.SYNC_SCHEMA || '/app/sync-schema.sql', 'utf8'));
  await sql.unsafe(await readFile(new URL('./notifications.sql', import.meta.url), 'utf8'));
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password || password.length < 12)
    throw new Error('ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 characters are required');
  const [existing] = await sql`SELECT id FROM mail0_user WHERE email=${email}`;
  if (!existing) {
    // Matches Better Auth 1.3's scrypt encoding. Existing accounts are never reset on restart.
    const salt = randomBytes(16).toString('hex');
    const key = scryptSync(password.normalize('NFKC'), salt, 64, {
      N: 16384,
      r: 16,
      p: 1,
      maxmem: 67108864,
    });
    const hash = `${salt}:${key.toString('hex')}`,
      id = randomUUID();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO mail0_user(id,name,email,email_verified,is_anonymous,created_at,updated_at) VALUES(${id},'Zero user',${email},true,false,now(),now())`;
      await tx`INSERT INTO mail0_account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES(${randomUUID()},${id},'credential',${id},${hash},now(),now())`;
    });
    console.log('Initial login account created');
  }
  console.log('Database ready');
} finally {
  await sql.end();
}
