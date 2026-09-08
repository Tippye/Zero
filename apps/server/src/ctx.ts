import type { Autumn } from 'autumn-js';
import type { Auth } from './lib/auth';
import type { ZeroEnv } from './env';
import type { createDb } from './db';

export type SessionUser = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>['user'];

export type HonoVariables = {
  auth: Auth;
  authDb?: ReturnType<typeof createDb>;
  sessionUser?: SessionUser;
  autumn?: Autumn;
  traceId?: string;
  requestId?: string;
};

export type HonoContext = { Variables: HonoVariables; Bindings: ZeroEnv };
