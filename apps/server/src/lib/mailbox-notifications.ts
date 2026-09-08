import { mailboxId } from './mailboxes/ids';
import { TRPCError } from '@trpc/server';
import { createDb } from '../db';
import { env } from '../env';

/** Shared durable event feed for desktop and native clients. Cursors remain decimal strings. */
export async function mailboxNotifications(owner: string | undefined, after?: string) {
  if (!owner) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Unauthorized' });
  if (env.SELF_HOSTED_AUTH !== 'required')
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Desktop event feed requires Compose deployment',
    });
  if (after !== undefined && !/^\d{1,18}$/.test(after))
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid cursor' });
  const { conn } = createDb(env.HYPERDRIVE.connectionString);
  try {
    const [latest] =
      await conn`SELECT coalesce(max(id),0)::text AS cursor FROM mail0_notification_events WHERE user_id=${owner}`;
    if (after === undefined) return { owner, cursor: latest.cursor as string, events: [] };
    // An arrival between these queries belongs to the next poll, beyond this page's cursor.
    const rows =
      await conn`SELECT e.id::text AS id,e.account_id,e.native_id,c.preview FROM mail0_notification_events e JOIN mail0_cached_mail c ON c.user_id=e.user_id AND c.account_id=e.account_id AND c.native_id=e.native_id AND c.kind='mail' WHERE e.user_id=${owner} AND e.id>${after}::bigint AND e.id<=${latest.cursor}::bigint AND e.created_at>now()-interval '1 day' AND 'inbox'=ANY(c.folders) AND 'UNREAD'=ANY(c.tags) ORDER BY e.id LIMIT 25`;
    return {
      owner,
      cursor: (rows.length === 25 ? rows.at(-1)!.id : latest.cursor) as string,
      events: rows.map((row) => ({
        id: row.id as string,
        accountId: row.account_id as string,
        threadId: mailboxId(row.account_id, row.native_id),
        subject: String(row.preview?.latest?.subject || 'New email').slice(0, 200),
        sender: String(
          row.preview?.latest?.sender?.name || row.preview?.latest?.sender?.email || '',
        ).slice(0, 100),
      })),
    };
  } finally {
    await conn.end();
  }
}
