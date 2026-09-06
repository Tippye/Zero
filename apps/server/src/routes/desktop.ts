import { mailboxId } from '../lib/mailboxes/ids';
import type { HonoContext } from '../ctx';
import { createDb } from '../db';
import { env } from '../env';
import { Hono } from 'hono';

export const desktopRouter = new Hono<HonoContext>();
desktopRouter.get('/info', (c) =>
  c.json({
    server: 'zero',
    apiVersion: 1,
    notifications: env.SELF_HOSTED_AUTH === 'required',
    protocols: ['mailto', 'zeromail'],
  }),
);
desktopRouter.get('/events', async (c) => {
  const owner = c.var.sessionUser?.id;
  if (!owner) return c.json({ error: 'Unauthorized' }, 401);
  if (env.SELF_HOSTED_AUTH !== 'required')
    return c.json({ error: 'Desktop event feed requires Compose deployment' }, 404);
  c.header('Cache-Control', 'no-store');
  const after = c.req.query('after');
  if (after !== undefined && !/^\d{1,18}$/.test(after))
    return c.json({ error: 'Invalid cursor' }, 400);
  const { conn } = createDb(env.HYPERDRIVE.connectionString);
  try {
    const [latest] =
      await conn`SELECT coalesce(max(id),0)::text AS cursor FROM mail0_notification_events WHERE user_id=${owner}`;
    if (after === undefined) return c.json({ owner, cursor: latest.cursor, events: [] });
    const rows =
      await conn`SELECT e.id::text AS id,e.account_id,e.native_id,c.preview FROM mail0_notification_events e JOIN mail0_cached_mail c ON c.user_id=e.user_id AND c.account_id=e.account_id AND c.native_id=e.native_id AND c.kind='mail' WHERE e.user_id=${owner} AND e.id>${after}::bigint AND e.created_at>now()-interval '1 day' AND 'inbox'=ANY(c.folders) AND 'UNREAD'=ANY(c.tags) ORDER BY e.id LIMIT 25`;
    return c.json({
      owner,
      cursor: rows.length === 25 ? rows.at(-1)!.id : latest.cursor,
      events: rows.map((r) => ({
        id: r.id,
        threadId: mailboxId(r.account_id, r.native_id),
        subject: String(r.preview?.latest?.subject || 'New email').slice(0, 200),
        sender: String(
          r.preview?.latest?.sender?.name || r.preview?.latest?.sender?.email || '',
        ).slice(0, 100),
      })),
    });
  } finally {
    await conn.end();
  }
});
