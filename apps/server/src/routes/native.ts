import { nativeMail } from '../lib/native-mail';
import { bodyLimit } from 'hono/body-limit';
import type { HonoContext } from '../ctx';
import { TRPCError } from '@trpc/server';
import { serverTrpc } from '../trpc';
import { ZodError } from 'zod';
import { Hono } from 'hono';

export const nativeRouter = new Hono<HonoContext>();
nativeRouter.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  // A browser cookie alone cannot invoke this API, including cross-site POSTs.
  if (!c.var.sessionUser || !c.req.header('Authorization')?.startsWith('Bearer '))
    return c.json({ error: 'unauthorized' }, 401);
  if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json'))
    return c.json({ error: 'invalid_request' }, 400);
  await next();
});
nativeRouter.use(
  '*',
  bodyLimit({
    maxSize: 24 * 1024 * 1024,
    onError: (c) => c.json({ error: 'request_too_large' }, 413),
  }),
);
nativeRouter.post('/v1/:operation', async (c) => {
  try {
    const body: unknown = await c.req.json();
    return c.body(
      JSON.stringify(await nativeMail(serverTrpc(), c.req.param('operation'), body)),
      200,
      { 'Content-Type': 'application/json' },
    );
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError)
      return c.json({ error: 'invalid_request' }, 400);
    if (error instanceof TRPCError) {
      const status = {
        UNAUTHORIZED: 401,
        FORBIDDEN: 403,
        NOT_FOUND: 404,
        BAD_REQUEST: 400,
        PRECONDITION_FAILED: 409,
        TOO_MANY_REQUESTS: 429,
      } as const;
      return c.json({ error: error.code }, status[error.code as keyof typeof status] || 502);
    }
    return c.json({ error: 'mailbox_unavailable' }, 502);
  }
});
