import { mailboxNotifications } from '../lib/mailbox-notifications';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeMail } from '../lib/native-mail';
import { TRPCError } from '@trpc/server';
import { nativeRouter } from './native';
import { Hono } from 'hono';

vi.mock('../trpc', () => ({ serverTrpc: () => ({}) }));
vi.mock('../lib/native-mail', () => ({ nativeMail: vi.fn() }));
vi.mock('../lib/mailbox-notifications', () => ({ mailboxNotifications: vi.fn() }));

afterEach(() => vi.resetAllMocks());
describe('native provider errors', () => {
  it('preserves a send operation conflict instead of reporting a transient gateway failure', async () => {
    vi.mocked(nativeMail).mockRejectedValue(new TRPCError({ code: 'CONFLICT' }));
    const app = new Hono<{ Variables: { sessionUser: { id: string } } }>();
    app.use('*', async (c, next) => {
      c.set('sessionUser', { id: 'synthetic-owner' });
      await next();
    });
    app.route('/native', nativeRouter);
    const response = await app.request('/native/v1/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer synthetic-test', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'CONFLICT' });
  });
  it('uses the authenticated event owner and preserves cursors beyond JavaScript integer precision', async () => {
    const value = { owner: 'synthetic-owner', cursor: '9007199254740993', events: [] };
    vi.mocked(mailboxNotifications).mockResolvedValue(value);
    const app = new Hono<{ Variables: { sessionUser: { id: string } } }>();
    app.use('*', async (c, next) => {
      c.set('sessionUser', { id: 'synthetic-owner' });
      await next();
    });
    app.route('/native', nativeRouter);
    const response = await app.request('/native/v1/events', {
      method: 'POST',
      headers: { Authorization: 'Bearer synthetic-test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ after: '9007199254740992', owner: 'foreign-owner' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(value);
    expect(mailboxNotifications).toHaveBeenCalledWith('synthetic-owner', '9007199254740992');
    expect(nativeMail).not.toHaveBeenCalled();
  });
});
