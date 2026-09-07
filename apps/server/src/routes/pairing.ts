import {
  PairingError,
  digest,
  limit,
  startPairing,
  previewPairing,
  decidePairing,
  exchangePairing,
} from '../../../../deploy/runtime/pairing-store.mjs';
import { selfHostedOrigin } from '../lib/selfhost';
import { setSignedCookie } from 'hono/cookie';
import type { HonoContext } from '../ctx';
import { createDb } from '../db';
import { env } from '../env';
import { Hono } from 'hono';

export const pairingRouter = new Hono<HonoContext>();
pairingRouter.use('*', async (c, next) => {
  if (env.SELF_HOSTED_AUTH !== 'required') return c.json({ error: 'not_available' }, 404);
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  const origin = selfHostedOrigin(c.req.raw, env);
  if (
    c.req.method === 'POST' &&
    (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json') ||
      (c.req.header('Origin') && c.req.header('Origin') !== origin) ||
      c.req.header('Sec-Fetch-Site') === 'cross-site')
  )
    return c.json({ error: 'invalid_origin' }, 403);
  await next();
});
pairingRouter.post('/:action', async (c) => {
  const { conn: sql } = createDb(env.HYPERDRIVE.connectionString);
  try {
    if (Number(c.req.header('Content-Length') || 0) > 4096)
      return c.json({ error: 'request_too_large' }, 413);
    const raw = await c.req.text();
    if (raw.length > 4096) return c.json({ error: 'request_too_large' }, 413);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'invalid_request' }, 400);
    const origin = selfHostedOrigin(c.req.raw, env);
    const action = c.req.param('action');
    // Nginx overwrites X-Forwarded-For. Never log addresses or pairing secrets.
    const ip = c.req.header('X-Forwarded-For') || c.req.header('CF-Connecting-IP') || 'direct';
    if (action === 'start') {
      await limit(sql, 'start:' + (await digest(ip)), 20);
      return c.json(
        await startPairing(sql, { origin, deviceName: body.deviceName, mode: body.mode }),
      );
    }
    if (action === 'exchange') {
      await limit(sql, 'exchange:' + (await digest(ip)), 600);
      const result = await exchangePairing(sql, {
        ...body,
        origin,
        userAgent: c.req.header('User-Agent') || '',
      });
      if (result.status !== 'authorized') return c.json(result);
      const context = await c.var.auth.$context;
      const cookie = context.authCookies.sessionToken;
      await setSignedCookie(c, cookie.name, result.session.token, context.secret, {
        ...cookie.options,
        maxAge: 60 * 60 * 24 * 30,
      });
      if (result.mode === 'native') {
        const key = await crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode(context.secret),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        );
        const signature = new Uint8Array(
          await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(result.session.token)),
        );
        // Better Auth's bearer transport expects the opaque cookie-encoded value,
        // including encoded base64 padding. Clients must not decode it.
        return c.json({
          status: 'authorized',
          token: encodeURIComponent(
            result.session.token + '.' + btoa(String.fromCharCode(...signature)),
          ),
          expiresAt: result.session.expires_at,
        });
      }
      return c.json({ status: 'authorized', expiresAt: result.session.expires_at });
    }
    const userId = c.var.sessionUser?.id;
    if (!userId) return c.json({ error: 'unauthorized' }, 401);
    await limit(sql, 'manage:' + userId, 60);
    if (action === 'preview') return c.json(await previewPairing(sql, body.code));
    if (action === 'approve' || action === 'deny')
      return c.json(
        await decidePairing(sql, {
          code: body.code,
          requestId: body.requestId,
          userId,
          approve: action === 'approve',
        }),
      );
    if (action === 'revoke') {
      if (typeof body.sessionId !== 'string') return c.json({ error: 'invalid_request' }, 400);
      const rows =
        await sql`DELETE FROM mail0_session WHERE id=${body.sessionId} AND user_id=${userId} RETURNING id`;
      return rows.length ? c.json({ revoked: true }) : c.json({ error: 'device_not_found' }, 404);
    }
    return c.json({ error: 'not_found' }, 404);
  } catch (error) {
    if (error instanceof PairingError) return c.json({ error: error.code }, error.status);
    console.error('Pairing operation failed', error instanceof Error ? error.message : 'unknown');
    return c.json({ error: 'pairing_unavailable' }, 503);
  } finally {
    await sql.end();
  }
});
pairingRouter.get('/devices', async (c) => {
  const current = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (!current) return c.json({ error: 'unauthorized' }, 401);
  const { conn: sql } = createDb(env.HYPERDRIVE.connectionString);
  try {
    const devices =
      await sql`SELECT s.id,coalesce(d.name,'Previously paired device') AS name,s.created_at AS "createdAt",s.expires_at AS "expiresAt",s.id=${current.session.id} AS current
      FROM mail0_session s LEFT JOIN mail0_pairing_device d ON d.session_id=s.id
      WHERE s.user_id=${current.user.id} AND s.expires_at>now() ORDER BY s.created_at DESC`;
    return c.json({
      devices: devices.map((device) => ({
        ...device,
        createdAt: new Date(device.createdAt).toISOString(),
        expiresAt: new Date(device.expiresAt).toISOString(),
      })),
    });
  } finally {
    await sql.end();
  }
});
