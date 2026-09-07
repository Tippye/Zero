import { createHash, randomUUID } from 'node:crypto';
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
  await sql.unsafe(await readFile(new URL('./pairing.sql', import.meta.url), 'utf8'));
  await sql.begin(async (tx) => {
    const [configured] = await tx`SELECT user_id FROM mail0_pairing_owner WHERE id=1`;
    if (configured) return;
    const users =
      await tx`SELECT id,email FROM mail0_user WHERE is_anonymous=false ORDER BY created_at`;
    const explicitId = process.env.PAIRING_OWNER_ID;
    const legacyEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    let owner = explicitId
      ? users.find((u) => u.id === explicitId)
      : legacyEmail
        ? users.find((u) => u.email === legacyEmail)
        : undefined;
    if (explicitId && !owner)
      throw new Error('PAIRING_OWNER_ID must identify an existing non-guest workspace');
    if (!owner && users.length === 1) owner = users[0];
    if (!owner && users.length > 1)
      throw new Error(
        'Multiple workspaces found. Set PAIRING_OWNER_ID to select the existing owner; no data was reassigned.',
      );
    if (!owner) {
      const id = randomUUID();
      [owner] =
        await tx`INSERT INTO mail0_user(id,name,email,email_verified,is_anonymous,created_at,updated_at)
        VALUES(${id},'Zero user',${id + '@workspace.zero.local'},true,false,now(),now()) RETURNING id,email`;
    }
    await tx`INSERT INTO mail0_pairing_owner(id,user_id) VALUES(1,${owner.id})`;
    // One-time cutover: password-era sessions must not authorize new devices.
    // The API no longer reads Redis sessions or signed session-data cookies.
    await tx`DELETE FROM mail0_session`;
    console.log(
      'Pairing enabled. Approve your first device with node pairing.mjs approve CODE --yes.',
    );
  });
  console.log('Database ready');
} finally {
  await sql.end();
}
