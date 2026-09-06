import { mailboxesRouter, unifiedMailRouter, unifiedDraftsRouter } from './routes/mailboxes';
import { type inferRouterInputs, type inferRouterOutputs } from '@trpc/server';
import { cookiePreferencesRouter } from './routes/cookies';
import { connectionsRouter } from './routes/connections';
import { categoriesRouter } from './routes/categories';
import { templatesRouter } from './routes/templates';
import { shortcutRouter } from './routes/shortcut';
import { settingsRouter } from './routes/settings';
import { getContext } from 'hono/context-storage';
import { draftsRouter } from './routes/drafts';
import { labelsRouter } from './routes/label';
import { notesRouter } from './routes/notes';
import { brainRouter } from './routes/brain';
import { userRouter } from './routes/user';
import { meetRouter } from './routes/meet';
import { mailRouter } from './routes/mail';
import { bimiRouter } from './routes/bimi';
import type { HonoContext } from '../ctx';
import { aiRouter } from './routes/ai';
import { router } from './trpc';
import { loggingRouter } from './routes/logging';
import { llmRouter } from './routes/llm';
import { imapRouter } from './routes/imap';

export const appRouter = router({
  imap: imapRouter,
  llm: llmRouter,
  ai: aiRouter,
  bimi: bimiRouter,
  brain: brainRouter,
  categories: categoriesRouter,
  connections: connectionsRouter,
  cookiePreferences: cookiePreferencesRouter,
  drafts: router({ ...draftsRouter._def.record, ...unifiedDraftsRouter._def.record }),
  labels: labelsRouter,
  mailboxes: mailboxesRouter,
  mail: router({ ...mailRouter._def.record, ...unifiedMailRouter._def.record }),
  notes: notesRouter,
  shortcut: shortcutRouter,
  settings: settingsRouter,
  user: userRouter,
  templates: templatesRouter,
  meet: meetRouter,
  logging: loggingRouter,
});

export type AppRouter = typeof appRouter;

export type Inputs = inferRouterInputs<AppRouter>;
export type Outputs = inferRouterOutputs<AppRouter>;

export const serverTrpc = () => {
  const c = getContext<HonoContext>();
  return appRouter.createCaller({
    c,
    sessionUser: c.var.sessionUser,
    auth: c.var.auth,
  });
};
