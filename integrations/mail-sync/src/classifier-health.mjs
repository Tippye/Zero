import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 3 });
try {
  const [row] =
    await sql`SELECT heartbeat_at>now()-interval '60 seconds' AS ok FROM mail0_classifier_health WHERE id=1`;
  process.exitCode = row?.ok ? 0 : 1;
} finally {
  await sql.end({ timeout: 1 });
}
