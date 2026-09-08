import { mailboxNotifications } from '../lib/mailbox-notifications';
import type { HonoContext } from '../ctx';
import { TRPCError } from '@trpc/server';
import { env } from '../env';
import { Hono } from 'hono';

export const desktopRouter = new Hono<HonoContext>();
desktopRouter.get('/info', (c) =>
  c.json({
    server: 'zero',
    apiVersion: 1,
    authentication:
      env.SELF_HOSTED_AUTH === 'required'
        ? { type: 'pairing', version: 1, endpoint: '/api/pairing' }
        : undefined,
    notifications: env.SELF_HOSTED_AUTH === 'required',
    protocols: ['mailto', 'zeromail'],
  }),
);
desktopRouter.get('/events', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    return c.json(await mailboxNotifications(c.var.sessionUser?.id, c.req.query('after')));
  } catch (error) {
    if (error instanceof TRPCError) {
      const status = { UNAUTHORIZED: 401, NOT_FOUND: 404, BAD_REQUEST: 400 } as const;
      return c.json({ error: error.message }, status[error.code as keyof typeof status] || 500);
    }
    throw error;
  }
});
