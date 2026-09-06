import type { IGetThreadResponse, IGetThreadsResponse } from '../driver/types';
import { mailboxId, splitMailboxId } from './ids';
import type { MailboxAccount } from './accounts';
import postgres, { type Sql } from 'postgres';
import { TRPCError } from '@trpc/server';
import { env } from '../../env';
import { z } from 'zod';
export const syncEnabled = () =>
  (env as typeof env & { MAIL_SYNC_ENABLED?: string }).MAIL_SYNC_ENABLED === 'true';
export const syncSettingsSchema = z.object({
  max_messages: z.number().int().min(50).max(5000),
  max_age_days: z.number().int().min(7).max(3650),
  body_budget_mb: z.number().int().min(5).max(1024),
  interval_seconds: z.number().int().min(60).max(3600),
});
const defaults = { max_messages: 500, max_age_days: 90, body_budget_mb: 50, interval_seconds: 120 };
export async function withDb<T>(fn: (sql: Sql) => Promise<T>) {
  const sql = postgres(env.HYPERDRIVE.connectionString, {
    max: 1,
    connect_timeout: 3,
    idle_timeout: 5,
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}
async function trim(sql: Sql, owner: string, settings: typeof defaults) {
  await sql`DELETE FROM mail0_mail_translations WHERE user_id=${owner} AND created_at<=now()-${settings.max_age_days}*interval '1 day'`;
  await sql`DELETE FROM mail0_cached_mail WHERE user_id=${owner} AND received_at<now()-${settings.max_age_days}*interval '1 day'`;
  await sql`DELETE FROM mail0_cached_mail WHERE (user_id,account_id,kind,native_id) IN (SELECT user_id,account_id,kind,native_id FROM (SELECT user_id,account_id,kind,native_id,row_number() OVER(PARTITION BY account_id ORDER BY received_at DESC,kind,native_id) AS n FROM mail0_cached_mail WHERE user_id=${owner}) ranked WHERE n>${settings.max_messages})`;
  await sql`UPDATE mail0_cached_mail SET body=NULL,body_bytes=0 WHERE (user_id,account_id,kind,native_id) IN (SELECT user_id,account_id,kind,native_id FROM (SELECT user_id,account_id,kind,native_id,sum(body_bytes) OVER(PARTITION BY account_id ORDER BY body_accessed_at DESC NULLS LAST,native_id) AS used FROM mail0_cached_mail WHERE user_id=${owner} AND body IS NOT NULL) b WHERE used>${settings.body_budget_mb * 1024 * 1024})`;
}
export async function syncSettings(owner: string) {
  return withDb(async (sql) => ({
    enabled: syncEnabled(),
    settings: {
      ...defaults,
      ...(
        await sql`SELECT max_messages,max_age_days,body_budget_mb,interval_seconds FROM mail0_sync_settings WHERE user_id=${owner}`
      )[0],
    },
  }));
}
export async function saveSyncSettings(owner: string, settings: typeof defaults) {
  return withDb(async (sql) => {
    await sql`INSERT INTO mail0_sync_settings(user_id,max_messages,max_age_days,body_budget_mb,interval_seconds) VALUES(${owner},${settings.max_messages},${settings.max_age_days},${settings.body_budget_mb},${settings.interval_seconds}) ON CONFLICT(user_id) DO UPDATE SET max_messages=excluded.max_messages,max_age_days=excluded.max_age_days,body_budget_mb=excluded.body_budget_mb,interval_seconds=excluded.interval_seconds`;
    await trim(sql, owner, settings);
    await sql`UPDATE mail0_sync_accounts SET requested_at=now(),checkpoint=NULL WHERE user_id=${owner}`;
    return { success: true };
  });
}
export async function requestClassification(owner: string) {
  if (!syncEnabled()) return;
  await withDb(async sql => {
    await sql`UPDATE mail0_sync_accounts SET classification_retry_at=now(),classification_error=NULL WHERE user_id=${owner}`;
  });
}
export async function requestSync(owner: string, accountId?: string) {
  if (!syncEnabled()) return { success: false };
  return withDb(async (sql) => {
    await sql`UPDATE mail0_sync_accounts SET requested_at=now(),classification_retry_at=now(),classification_error=NULL WHERE user_id=${owner} AND (${accountId || null}::text IS NULL OR account_id=${accountId || null})`;
    return { success: true };
  });
}
export async function syncStatus(owner: string, accounts: MailboxAccount[]) {
  return withDb(async (sql) => {
    const states =
      await sql`SELECT s.account_id,s.status,s.error_code,s.last_synced_at,s.classification_error,s.classification_updated_at,count(c.native_id) FILTER(WHERE c.kind='mail' AND 'inbox'=ANY(c.folders))::int AS classification_total,count(c.native_id) FILTER(WHERE c.kind='mail' AND 'inbox'=ANY(c.folders) AND ((c.ai_source_hash=md5(c.search_text) AND c.ai_category IS NOT NULL) OR EXISTS(SELECT 1 FROM mail0_category_feedback f WHERE f.user_id=c.user_id AND f.account_id=c.account_id AND f.native_id=c.native_id)))::int AS classified_count,s.requested_at>s.completed_request_at AS queued,count(c.native_id)::int AS cached_count,coalesce(sum(c.body_bytes),0)::int AS body_bytes FROM mail0_sync_accounts s LEFT JOIN mail0_cached_mail c USING(user_id,account_id) WHERE s.user_id=${owner} GROUP BY s.user_id,s.account_id`;
    const [health] =
      await sql`SELECT heartbeat_at>now()-interval '90 seconds' AS online FROM mail0_sync_worker_health WHERE id=1`;
    return {
      enabled: syncEnabled(),
      workerOnline: !!health?.online,
      accounts: accounts.map((a) => {
        const row = states.find((s) => s.account_id === a.id);
        return {
          accountId: a.id,
          email: a.email,
          status: row?.status || 'pending',
          queued: !!row?.queued,
          errorCode: row?.error_code || null,
          lastSyncedAt: row?.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
          cachedCount: Number(row?.cached_count || 0),
          classificationTotal: Number(row?.classification_total || 0),
          classifiedCount: Number(row?.classified_count || 0),
          classificationError: row?.classification_error || null,
          classificationUpdatedAt: row?.classification_updated_at ? new Date(row.classification_updated_at).toISOString() : null,
          bodyBytes: Number(row?.body_bytes || 0),
        };
      }),
    };
  });
}
const cacheCursor = z.object({
  version: z.literal('local-v1'),
  scope: z.string(),
  at: z.string().datetime(),
  account: z.string(),
  kind: z.string(),
  id: z.string(),
});
export async function cachedThreads(
  owner: string,
  accounts: MailboxAccount[],
  input: {
    accountId?: string;
    folder: string;
    q: string;
    labelIds: string[];
    maxResults: number;
    cursor: string;
  },
) {
  const scope = JSON.stringify([
    owner,
    input.accountId || '',
    input.folder,
    input.q,
    input.labelIds,
  ]);
  let cursor: z.infer<typeof cacheCursor> | undefined;
  if (input.cursor) {
    try {
      cursor = cacheCursor.parse(JSON.parse(input.cursor));
      if (cursor.scope !== scope) throw Error();
    } catch {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Refresh this folder to restart local pagination.',
      });
    }
  }
  const accountIds = accounts.map((a) => a.id);
  const rows = await withDb(async (sql) => {
    // Local substring search supports common Gmail-style field/read/star filters.
    const tokens = input.q.toLowerCase().match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const conditions = tokens.map((token) => {
      const value = token.replace(/^"|"$/g, '');
      if (value === 'is:unread') return sql`'UNREAD'=ANY(tags)`;
      if (value === 'is:read') return sql`NOT('UNREAD'=ANY(tags))`;
      if (value === 'is:starred') return sql`'STARRED'=ANY(tags)`;
      if (value.startsWith('from:'))
        return sql`position(${value.slice(5)} IN lower(coalesce(preview->'latest'->'sender'->>'email','')))>0`;
      if (value.startsWith('subject:'))
        return sql`position(${value.slice(8)} IN lower(coalesce(preview->'latest'->>'subject',draft_preview->>'subject','')))>0`;
      return sql`position(${value} IN search_text)>0`;
    });
    const categoryLabels: Record<string, string> = { ZERO_CATEGORY_PRIMARY: 'primary', ZERO_CATEGORY_TRANSACTIONS: 'transactions', ZERO_CATEGORY_UPDATES: 'updates', ZERO_CATEGORY_PROMOTIONS: 'promotions' };
    const selectedCategories = input.labelIds.filter(label => categoryLabels[label]).map(label => categoryLabels[label]!);
    const providerLabels = input.labelIds.filter(label => !categoryLabels[label]);
    let search = selectedCategories.length ? sql`coalesce((SELECT f.category FROM mail0_category_feedback f WHERE f.user_id=mail0_cached_mail.user_id AND f.account_id=mail0_cached_mail.account_id AND f.native_id=mail0_cached_mail.native_id),CASE WHEN ai_source_hash=md5(search_text) THEN ai_category END)=ANY(${selectedCategories}::text[])` : sql`true`;
    for (const condition of conditions) search = sql`${search} AND ${condition}`;
    return sql`SELECT account_id,native_id,kind,received_at,preview,draft_preview FROM mail0_cached_mail WHERE user_id=${owner} AND account_id=ANY(${accountIds}::text[]) AND ${input.folder}=ANY(folders) AND tags @> ${providerLabels}::text[] AND ${search}
      AND (${cursor?.at || null}::timestamptz IS NULL OR (received_at,account_id,kind,native_id)<(${cursor?.at || null}::timestamptz,${cursor?.account || ''},${cursor?.kind || ''},${cursor?.id || ''}))
      ORDER BY received_at DESC,account_id DESC,kind DESC,native_id DESC LIMIT ${input.maxResults + 1}`;
  });
  const more = rows.length > input.maxResults,
    page = rows.slice(0, input.maxResults),
    last = page.at(-1);
  const threads = page.map((row) => ({
    id: mailboxId(row.account_id, row.native_id),
    historyId: null,
    accountId: row.account_id,
    accountEmail: accounts.find((a) => a.id === row.account_id)?.email || '',
    $raw: {
      receivedOn: new Date(row.received_at).toISOString(),
      preview: row.preview as IGetThreadResponse | undefined,
      draftPreview: row.draft_preview,
    },
  }));
  return {
    threads: threads as (IGetThreadsResponse['threads'][number] & {
      accountId: string;
      accountEmail: string;
    })[],
    warnings: [] as { accountId: string; email: string; message: string; code?: string }[],
    nextPageToken:
      more && last
        ? JSON.stringify({
            version: 'local-v1',
            scope,
            at: new Date(last.received_at).toISOString(),
            account: last.account_id,
            kind: last.kind,
            id: last.native_id,
          })
        : null,
  };
}
export async function cachedBody(owner: string, account: string, id: string) {
  if (!syncEnabled()) return null;
  return withDb(async (sql) => {
    const [row] =
      await sql`SELECT body,version FROM mail0_cached_mail WHERE user_id=${owner} AND account_id=${account} AND native_id=${id} AND kind='mail'`;
    if (row?.body)
      await sql`UPDATE mail0_cached_mail SET body_accessed_at=now() WHERE user_id=${owner} AND account_id=${account} AND native_id=${id} AND kind='mail'`;
    return row
      ? { body: row.body?._bodyFormatVersion === 2 ? row.body as IGetThreadResponse : null, version: row.version as string }
      : null;
  });
}
export async function storeBody(
  owner: string,
  account: string,
  id: string,
  version: string,
  data: IGetThreadResponse,
) {
  const bytes = new TextEncoder().encode(JSON.stringify(data)).byteLength;
  if (bytes > 5 * 1024 * 1024) return;
  await withDb(async (sql) => {
    await sql`UPDATE mail0_cached_mail SET body=${sql.json({ ...data, _bodyFormatVersion: 2 } as any)},body_bytes=${bytes},body_accessed_at=now() WHERE user_id=${owner} AND account_id=${account} AND native_id=${id} AND kind='mail' AND version=${version}`;
    const settings = {
      ...defaults,
      ...(await sql`SELECT * FROM mail0_sync_settings WHERE user_id=${owner}`)[0],
    };
    await trim(sql, owner, settings);
  });
}
export async function removeCached(owner: string, encoded: string) {
  if (!syncEnabled()) return;
  const parsed = splitMailboxId(encoded);
  if (!parsed) return;
  await withDb(async (sql) => {
    await sql`DELETE FROM mail0_cached_mail WHERE user_id=${owner} AND account_id=${parsed.accountId} AND native_id=${parsed.id}`;
  });
}
export async function patchCachedLabels(
  owner: string,
  account: MailboxAccount,
  ids: string[],
  add: string[],
  remove: string[],
) {
  if (!syncEnabled()) return;
  await withDb(async (sql) => {
    if (
      account.providerId === 'imap' &&
      add.some((t) => ['TRASH', 'ARCHIVE', 'SPAM'].includes(t))
    ) {
      await sql`DELETE FROM mail0_cached_mail WHERE user_id=${owner} AND account_id=${account.id} AND native_id=ANY(${ids}::text[])`;
      return;
    }
    const rows =
      await sql`SELECT native_id,kind,tags,folders,preview FROM mail0_cached_mail WHERE user_id=${owner} AND account_id=${account.id} AND native_id=ANY(${ids}::text[])`;
    for (const row of rows) {
      const tags = [
        ...new Set([...(row.tags as string[]).filter((t) => !remove.includes(t)), ...add]),
      ];
      const labels = tags.map((id) => ({ id, name: id, type: 'system' }));
      const p = row.preview as IGetThreadResponse;
      if (p) {
        p.labels = labels;
        p.hasUnread = tags.includes('UNREAD');
        for (const m of [...p.messages, ...(p.latest ? [p.latest] : [])]) {
          m.tags = labels;
          m.unread = p.hasUnread;
        }
      }
      const folders =
        account.providerId === 'google'
          ? ['inbox', 'sent', 'draft', 'spam', 'bin', 'starred', 'archive'].filter((f) =>
              f === 'archive'
                ? !tags.some((t) => ['INBOX', 'DRAFT', 'SPAM', 'TRASH'].includes(t))
                : tags.includes(
                    (
                      {
                        inbox: 'INBOX',
                        sent: 'SENT',
                        draft: 'DRAFT',
                        spam: 'SPAM',
                        bin: 'TRASH',
                        starred: 'STARRED',
                      } as Record<string, string>
                    )[f]!,
                  ),
            )
          : [
              ...(row.folders as string[]).filter((f) => f !== 'starred'),
              ...(tags.includes('STARRED') ? ['starred'] : []),
            ];
      await sql`UPDATE mail0_cached_mail SET tags=${tags},folders=${folders},preview=${sql.json(p as any)},body=NULL,body_bytes=0 WHERE user_id=${owner} AND account_id=${account.id} AND native_id=${row.native_id} AND kind=${row.kind}`;
    }
  });
}

export const manualCategorySchema = z.enum(['primary', 'transactions', 'updates', 'promotions']);

export async function moveCachedCategory(owner: string, account: string, id: string, category: z.infer<typeof manualCategorySchema>) {
  if (!syncEnabled()) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Local mail sync is required.' });
  return withDb(sql => sql.begin(async tx => {
    // Lock the message so an in-flight classifier cannot replace this explicit choice.
    const [row] = await tx`SELECT preview FROM mail0_cached_mail WHERE user_id=${owner} AND account_id=${account} AND native_id=${id} AND kind='mail' FOR UPDATE`;
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Message is not available in the local cache. Sync and retry.' });
    const sender = String(row.preview?.latest?.sender?.email || '').slice(0, 320);
    const subject = String(row.preview?.latest?.subject || '').slice(0, 1000);
    await tx`INSERT INTO mail0_category_feedback(user_id,account_id,native_id,category,sender,subject) VALUES(${owner},${account},${id},${category},${sender},${subject}) ON CONFLICT(user_id,account_id,native_id) DO UPDATE SET category=excluded.category,sender=excluded.sender,subject=excluded.subject,updated_at=now()`;
    await tx`UPDATE mail0_cached_mail SET ai_category=${category},ai_source_hash=md5(search_text),ai_classified_at=now() WHERE user_id=${owner} AND account_id=${account} AND native_id=${id} AND kind='mail'`;
    return { success: true };
  }));
}

export async function cachedCategory(owner: string, account: string, id: string) {
  if (!syncEnabled()) return { enabled: false, category: null };
  return withDb(async sql => {
    const [row] = await sql`SELECT coalesce(f.category,CASE WHEN c.ai_source_hash=md5(c.search_text) THEN c.ai_category END) AS category FROM mail0_cached_mail c LEFT JOIN mail0_category_feedback f USING(user_id,account_id,native_id) WHERE c.user_id=${owner} AND c.account_id=${account} AND c.native_id=${id} AND c.kind='mail'`;
    return { enabled: true, category: (row?.category as z.infer<typeof manualCategorySchema> | undefined) ?? null };
  });
}
