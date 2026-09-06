export async function upsert(sql, account, rows) {
  for (const r of rows.filter(Boolean)) {
    // A single row is capped too: malformed metadata cannot exhaust the cache.
    if (Buffer.byteLength(JSON.stringify(r)) > 256 * 1024) continue;
    await sql`INSERT INTO mail0_cached_mail (user_id,account_id,native_id,kind,folders,tags,received_at,search_text,preview,draft_preview,version)
      VALUES (${account.user_id},${account.account_id},${r.native_id},${r.kind},${r.folders},${r.tags},${r.received_at},${r.search_text},${sql.json(r.preview)},${sql.json(r.draft_preview)},${r.version})
      ON CONFLICT(user_id,account_id,kind,native_id) DO UPDATE SET folders=excluded.folders,tags=excluded.tags,received_at=excluded.received_at,search_text=excluded.search_text,preview=excluded.preview,draft_preview=excluded.draft_preview,version=excluded.version,
      body=CASE WHEN mail0_cached_mail.version=excluded.version THEN mail0_cached_mail.body ELSE NULL END,
      body_bytes=CASE WHEN mail0_cached_mail.version=excluded.version THEN mail0_cached_mail.body_bytes ELSE 0 END`;
  }
}
export async function prune(sql, account, settings) {
  await sql`DELETE FROM mail0_cached_mail WHERE user_id=${account.user_id} AND account_id=${account.account_id} AND received_at < now() - ${settings.max_age_days} * interval '1 day'`;
  await sql`DELETE FROM mail0_cached_mail WHERE (user_id,account_id,kind,native_id) IN (
    SELECT user_id,account_id,kind,native_id FROM mail0_cached_mail WHERE user_id=${account.user_id} AND account_id=${account.account_id}
    ORDER BY received_at DESC,kind,native_id OFFSET ${settings.max_messages})`;
  await sql`UPDATE mail0_cached_mail SET body=NULL,body_bytes=0 WHERE (user_id,account_id,kind,native_id) IN (
    SELECT user_id,account_id,kind,native_id FROM (SELECT user_id,account_id,kind,native_id,
    sum(body_bytes) OVER(ORDER BY body_accessed_at DESC NULLS LAST,native_id) AS used
    FROM mail0_cached_mail WHERE user_id=${account.user_id} AND account_id=${account.account_id} AND body IS NOT NULL) b
    WHERE used > ${settings.body_budget_mb * 1024 * 1024})`;
}
