import {
  syncEnabled,
  moveCachedCategory,
  cachedCategory,
  manualCategorySchema,
  cachedThreads,
  cachedBody,
  storeBody,
  requestSync,
  syncStatus,
  syncSettings,
  saveSyncSettings,
  syncSettingsSchema,
  patchCachedLabels,
  removeCached,
} from '../../lib/mailboxes/cache';
import {
  imapBridge,
  type ImapPage,
  type ImapThread,
  type ImapSendResult,
} from '../../lib/imap-bridge';
import type { IGetThreadResponse, IGetThreadsResponse, ParsedDraft } from '../../lib/driver/types';
import { mailboxAccounts, ownedMailbox, type MailboxAccount } from '../../lib/mailboxes/accounts';
import { initTRPC, TRPCError, type inferRouterOutputs } from '@trpc/server';
import { createDraftData, serializedFileSchema } from '../../lib/schemas';
import { mailboxId, splitMailboxId } from '../../lib/mailboxes/ids';
import { getZeroDB, getZeroAgent } from '../../lib/server-utils';
import { createSingleFlight } from '../../lib/single-flight';
import { draftsRouter as legacyDrafts } from './drafts';
import { mailRouter as legacyMail } from './mail';
import type { TrpcContext } from '../trpc';
import superjson from 'superjson';
import { z } from 'zod';

const t = initTRPC.context<TrpcContext>().create({ transformer: superjson });
const owned = t.procedure.use(async ({ ctx, next, type, path, getRawInput }) => {
  if (!ctx.sessionUser) throw new TRPCError({ code: 'UNAUTHORIZED' });
  try {
    const result = await next({ ctx: { ...ctx, sessionUser: ctx.sessionUser } });
    if (syncEnabled() && type === 'mutation' && result.ok) {
      const input = (await getRawInput()) as { id?: string; draftId?: string };
      const oldDraft =
        path === 'drafts.delete' ? input.id : path === 'mail.send' ? input.draftId : undefined;
      if (oldDraft) await removeCached(ctx.sessionUser.id, oldDraft).catch(() => {});
    }
    return result;
  } finally {
    if (type === 'mutation') {
      if (syncEnabled() && !path.startsWith('mailboxes.')) {
        const raw = (await getRawInput()) as {
          accountId?: string;
          id?: string;
          draftId?: string;
          threadId?: string | string[];
          ids?: string[];
        };
        const encoded = [
          raw.id,
          raw.draftId,
          ...(Array.isArray(raw.threadId) ? raw.threadId : [raw.threadId]),
          ...(raw.ids || []),
        ];
        const affected = new Set(
          [
            raw.accountId,
            ...encoded.map((value) => (value ? splitMailboxId(value)?.accountId : undefined)),
          ].filter((value): value is string => !!value),
        );
        if (affected.size)
          await Promise.all(
            [...affected].map((account) =>
              requestSync(ctx.sessionUser.id, account).catch(() => {}),
            ),
          );
        else await requestSync(ctx.sessionUser.id).catch(() => {});
      }
      for (const [key, entry] of pageCache)
        if (entry.owner === ctx.sessionUser.id) pageCache.delete(key);
    }
  }
});
type Ctx = TrpcContext & { sessionUser: NonNullable<TrpcContext['sessionUser']> };
type MailOutputs = inferRouterOutputs<typeof legacyMail>;
const id = z.string().min(1).max(16000);
const scope = z.object({ accountId: z.string().optional() });
const ids = z.object({ ids: z.array(id).min(1).max(100) });
const single = z.object({ id });
const recipient = z.object({ email: z.string().email(), name: z.string().optional() });
async function oauth(ctx: Ctx, a: MailboxAccount) {
  const db = await getZeroDB(ctx.sessionUser.id);
  const connection = await db.findUserConnection(a.id);
  if (!connection) throw new TRPCError({ code: 'NOT_FOUND' });
  return { ...ctx, mailboxConnection: connection };
}
async function target(ctx: Ctx, encoded: string, accountId?: string) {
  const parsed = splitMailboxId(encoded);
  if (parsed && accountId && parsed.accountId !== accountId)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Mailbox does not match this message.' });
  return {
    account: await ownedMailbox(ctx.sessionUser.id, parsed?.accountId || accountId),
    id: parsed?.id || encoded,
  };
}
function wrapThread(a: MailboxAccount, thread: IGetThreadResponse): IGetThreadResponse {
  const wrap = (message: IGetThreadResponse['messages'][number]) => ({
    ...message,
    id: mailboxId(a.id, message.id),
    threadId: mailboxId(a.id, message.threadId || message.id),
  });
  return {
    ...thread,
    messages: thread.messages.map(wrap),
    latest: thread.latest ? wrap(thread.latest) : undefined,
  };
}
const mailReads = createSingleFlight<IGetThreadResponse>();
async function getMail(ctx: Ctx, encoded: string): Promise<IGetThreadResponse> {
  try {
    const { account: a, id } = await target(ctx, encoded);
    return await mailReads(JSON.stringify([ctx.sessionUser.id, a.id, id]), () =>
      loadMail(ctx, a, id),
    );
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'TOO_MANY_REQUESTS') {
      ctx.c.header('Retry-After', error.message.startsWith('RATE_LIMIT:') ? '60' : '5');
    }
    throw error;
  }
}
async function loadMail(ctx: Ctx, a: MailboxAccount, id: string): Promise<IGetThreadResponse> {
  const cached = await cachedBody(ctx.sessionUser.id, a.id, id).catch(() => null);
  if (cached?.body) return cached.body;
  const data =
    a.providerId === 'imap'
      ? await imapBridge<ImapThread>(ctx.sessionUser.id, 'mail.get', { accountId: a.id, id })
      : await legacyMail
          .createCaller(await oauth(ctx, a))
          .get({ id, fresh: a.providerId === 'google' });
  const wrapped = wrapThread(a, data);
  if (cached)
    await storeBody(ctx.sessionUser.id, a.id, id, cached.version, wrapped).catch(() => {});
  return wrapped;
}
async function groups(ctx: Ctx, values: string[]) {
  const accounts = await mailboxAccounts(ctx.sessionUser.id);
  const result = new Map<string, { account: MailboxAccount; ids: string[] }>();
  for (const encoded of values) {
    const parsed = splitMailboxId(encoded);
    const account = parsed
      ? accounts.find((a) => a.id === parsed.accountId)
      : accounts.find((a) => a.connected);
    if (!account?.connected)
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Mailbox unavailable or not owned by this workspace.',
      });
    const group = result.get(account.id) || { account, ids: [] };
    group.ids.push(parsed?.id || encoded);
    result.set(account.id, group);
  }
  return [...result.values()];
}

async function modify(ctx: Ctx, values: string[], addLabels: string[], removeLabels: string[]) {
  // Resolve and validate every owner before changing any mailbox.
  const selected = await groups(ctx, values);
  for (const { account: a } of selected) {
    if (
      a.providerId === 'imap' &&
      [...addLabels, ...removeLabels].some(
        (x) =>
          !['UNREAD', 'STARRED', 'IMPORTANT', 'INBOX', 'TRASH', 'SPAM', 'ARCHIVE', 'SENT'].includes(
            x,
          ),
      )
    ) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'This mailbox does not support that label.',
      });
    }
  }
  await Promise.all(
    selected.map(async ({ account: a, ids }) => {
      if (a.providerId === 'imap')
        return imapBridge(ctx.sessionUser.id, 'mail.modify', {
          accountId: a.id,
          ids,
          addLabels: addLabels.filter((x) => x !== 'SENT'),
          removeLabels: removeLabels.filter((x) => x !== 'SENT'),
        });
      return legacyMail.createCaller(await oauth(ctx, a)).modifyLabels({
        threadId: ids,
        addLabels: addLabels.filter((l) => l !== 'ARCHIVE'),
        removeLabels,
      });
    }),
  );
  await Promise.all(
    selected.map((g) =>
      patchCachedLabels(ctx.sessionUser.id, g.account, g.ids, addLabels, removeLabels).catch(
        () => {},
      ),
    ),
  );
  return { success: true };
}
async function mapLimited<T, R>(values: T[], fn: (value: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, values.length) }, async () => {
      while (index < values.length) {
        const i = index++;
        result[i] = await fn(values[i]!);
      }
    }),
  );
  return result;
}
function imapPreview(
  a: MailboxAccount,
  item: IGetThreadsResponse['threads'][number],
  folder: string,
): IGetThreadResponse {
  const raw = item.$raw as any;
  const tags = [
    {
      id: folder === 'draft' ? 'DRAFT' : folder.toUpperCase(),
      name: folder === 'draft' ? 'DRAFT' : folder.toUpperCase(),
    },
    ...(raw.unread ? [{ id: 'UNREAD', name: 'UNREAD' }] : []),
    ...(raw.starred ? [{ id: 'STARRED', name: 'STARRED' }] : []),
  ].map((tag) => ({ ...tag, type: 'system' }));
  const latest = {
    id: item.id,
    threadId: item.id,
    sender: raw.from?.[0] || { name: raw.sender || '', email: '' },
    to: raw.to || [],
    cc: raw.cc || [],
    bcc: raw.bcc || [],
    subject: raw.subject,
    title: raw.subject,
    receivedOn: raw.receivedOn,
    body: '',
    decodedBody: '',
    processedHtml: '',
    blobUrl: '',
    attachments: [],
    tags,
    tls: true,
    isDraft: folder === 'draft',
    unread: !!raw.unread,
  };
  return wrapThread(a, {
    messages: [latest],
    latest,
    hasUnread: !!raw.unread,
    totalReplies: 1,
    labels: tags,
  });
}
async function listOne(
  ctx: Ctx,
  a: MailboxAccount,
  input: { folder: string; q: string; maxResults: number; labelIds: string[] },
  cursor?: string,
): Promise<IGetThreadsResponse> {
  if (a.providerId === 'imap') {
    if (input.folder === 'snoozed') return { threads: [], nextPageToken: null };
    const page = await imapBridge<ImapPage>(ctx.sessionUser.id, 'mail.list', {
      accountId: a.id,
      folder: input.folder,
      query: input.q,
      maxResults: input.maxResults,
      pageToken: cursor,
      labelIds: input.labelIds,
    });
    return {
      ...page,
      threads: page.threads.map((item) => ({
        ...item,
        $raw: {
          ...item.$raw,
          preview: imapPreview(a, item, input.folder),
          draftPreview:
            input.folder === 'draft'
              ? {
                  id: mailboxId(a.id, item.id),
                  to: (item.$raw as any).to?.map((a: any) => a.email) || [],
                  subject: item.$raw.subject,
                  rawMessage: { internalDate: String(new Date(item.$raw.receivedOn).getTime()) },
                }
              : undefined,
        },
      })),
    };
  }
  const { stub } = await getZeroAgent(a.id, ctx.c.executionCtx);
  if (input.folder === 'draft') {
    const page = (await stub.listDrafts({
      q: input.q,
      maxResults: input.maxResults,
      pageToken: cursor,
    })) as unknown as IGetThreadsResponse;
    return {
      ...page,
      threads: page.threads.map((item) => ({
        ...item,
        $raw: {
          ...(item.$raw as object),
          draftPreview: {
            id: mailboxId(a.id, item.id),
            subject: (item.$raw as any)?.subject,
            to: (item.$raw as any)?.to?.map((a: any) => a.email),
            rawMessage: {
              internalDate: String(new Date((item.$raw as any)?.receivedOn || 0).getTime()),
            },
          },
        },
      })),
    };
  }
  if (input.folder === 'snoozed')
    return legacyMail
      .createCaller(await oauth(ctx, a))
      .listThreads({ ...input, cursor: cursor || '' });
  const page = (await stub.rawListThreads({
    folder: input.folder,
    query: input.q,
    maxResults: input.maxResults,
    labelIds: input.labelIds,
    pageToken: cursor,
  })) as unknown as IGetThreadsResponse;
  const threads = await mapLimited(page.threads, async (item) => {
    const data = await stub.getProviderThread(item.id);
    const latest = data.latest;
    const preview = wrapThread(a, {
      ...data,
      messages: data.messages.map((m) => ({
        ...m,
        body: '',
        decodedBody: '',
        processedHtml: '',
        attachments: [],
      })),
      latest: latest
        ? { ...latest, body: '', decodedBody: '', processedHtml: '', attachments: [] }
        : undefined,
    });
    return { ...item, $raw: { receivedOn: latest?.receivedOn || '', preview } };
  });
  return { ...page, threads };
}
// A short per-owner/account cache shares pages between aggregate and individual views.
// Every mutation invalidates it, including uncertain sends, so draft/flag changes stay fresh.
const pageCache = new Map<
  string,
  { owner: string; expires: number; task: Promise<IGetThreadsResponse> }
>();
function cachedListOne(
  ctx: Ctx,
  a: MailboxAccount,
  input: Parameters<typeof listOne>[2],
  cursor?: string,
) {
  const key = JSON.stringify([
    ctx.sessionUser.id,
    a.id,
    input.folder,
    input.q,
    input.maxResults,
    input.labelIds,
    cursor || '',
  ]);
  const hit = pageCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.task;
  if (pageCache.size >= 100) pageCache.delete(pageCache.keys().next().value!);
  const entry = {
    owner: ctx.sessionUser.id,
    expires: Date.now() + 35_000,
    task: null as unknown as Promise<IGetThreadsResponse>,
  };
  entry.task = bounded(listOne(ctx, a, input, cursor), a.providerId === 'imap' ? 35_000 : 15_000)
    .then((page) => {
      entry.expires = Date.now() + 30_000;
      return page;
    })
    .catch((error) => {
      if (pageCache.get(key) === entry) pageCache.delete(key);
      throw error;
    });
  pageCache.set(key, entry);
  return entry.task;
}
function mailboxFailure(error: unknown) {
  const message =
    error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message
      : '';
  if (/quota|rate.?limit|too many/i.test(message)) return 'RATE_LIMIT';
  if (/timeout|timed out|unreachable/i.test(message)) return 'TIMEOUT';
  if (/disconnected|authentication|authorization|auth_failed/i.test(message)) return 'DISCONNECTED';
  return 'UNAVAILABLE';
}
// Cursor contains only offsets. Ownership is resolved anew on each page; no credentials or email bodies.
const bufferItem = z.object({ id, historyId: z.string().nullable(), receivedOn: z.string() });
const cursorSchema = z.object({
  version: z.literal(2),
  scope: z.string(),
  states: z.record(z.object({ next: z.string().nullable(), buffer: z.array(bufferItem).max(30) })),
});
async function bounded<T>(task: Promise<T>, timeoutMs = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Mailbox timeout')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export const mailboxesRouter = t.router({
  category: owned.input(single).query(async ({ ctx, input }) => {
    const selected = await target(ctx, input.id);
    return cachedCategory(ctx.sessionUser.id, selected.account.id, selected.id);
  }),
  moveCategory: owned
    .input(single.extend({ category: manualCategorySchema }))
    .mutation(async ({ ctx, input }) => {
      const selected = await target(ctx, input.id);
      return moveCachedCategory(
        ctx.sessionUser.id,
        selected.account.id,
        selected.id,
        input.category,
      );
    }),
  syncStatus: owned.input(scope.optional()).query(async ({ ctx, input }) => {
    const accounts = await mailboxAccounts(ctx.sessionUser.id);
    return syncStatus(
      ctx.sessionUser.id,
      input?.accountId ? accounts.filter((a) => a.id === input.accountId) : accounts,
    );
  }),
  syncNow: owned.input(scope.optional()).mutation(async ({ ctx, input }) => {
    if (input?.accountId) await ownedMailbox(ctx.sessionUser.id, input.accountId);
    return requestSync(ctx.sessionUser.id, input?.accountId);
  }),
  syncSettings: owned.query(({ ctx }) => syncSettings(ctx.sessionUser.id)),
  saveSyncSettings: owned
    .input(syncSettingsSchema)
    .mutation(({ ctx, input }) => saveSyncSettings(ctx.sessionUser.id, input)),
  accounts: owned
    .input(z.object({ workspaceId: z.string().optional() }).optional())
    .query(({ ctx }) => mailboxAccounts(ctx.sessionUser.id)),
});
export const unifiedMailRouter = t.router({
  get: owned
    .input(single.extend({ fresh: z.boolean().optional() }))
    .query(({ ctx, input }) => getMail(ctx, input.id)),
  listThreads: owned
    .input(
      scope.extend({
        folder: z.string().default('inbox'),
        q: z.string().default(''),
        maxResults: z.number().int().min(1).max(30).default(20),
        cursor: z.string().max(512000).default(''),
        labelIds: z.array(z.string()).default([]),
      }),
    )
    .query(async ({ ctx, input }) => {
      const all = await mailboxAccounts(ctx.sessionUser.id);
      if (input.accountId && !all.some((a) => a.id === input.accountId))
        throw new TRPCError({ code: 'NOT_FOUND' });
      const accounts = input.accountId ? all.filter((a) => a.id === input.accountId) : all;
      if (
        syncEnabled() &&
        input.folder !== 'snoozed' &&
        accounts.every((a) => ['google', 'imap'].includes(a.providerId))
      )
        return cachedThreads(ctx.sessionUser.id, accounts, input);
      if (input.labelIds.some((label) => label.startsWith('ZERO_CATEGORY_')))
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'AI categories require local mailbox synchronization.',
        });
      const signature = JSON.stringify([
        ctx.sessionUser.id,
        input.accountId || '',
        input.folder,
        input.q,
        input.labelIds,
      ]);
      type State = z.infer<typeof cursorSchema>['states'][string];
      let states: Record<string, State> = {};
      if (input.cursor) {
        let parsed;
        try {
          parsed = cursorSchema.parse(JSON.parse(input.cursor));
        } catch {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Refresh this folder to restart pagination.',
          });
        }
        if (parsed.scope !== signature)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Folder filters changed; refresh the list.',
          });
        states = parsed.states;
      }
      const warnings: { accountId: string; email: string; message: string; code?: string }[] =
        accounts
          .filter((a) => a.warning && (!input.accountId || a.providerId === 'imap'))
          .map((a) => ({
            accountId: a.id,
            email: a.providerId === 'imap' ? a.email : 'IMAP',
            message: a.warning!,
            code: 'UNAVAILABLE',
          }));
      const loaded = new Map<string, IGetThreadsResponse['threads'][number]>();
      async function fill(a: MailboxAccount) {
        const state = states[a.id];
        if (state?.buffer.length || (state && state.next === null)) return;
        try {
          if (!a.connected) throw new Error('Mailbox disconnected');
          const page = await cachedListOne(ctx, a, input, state?.next || undefined);
          const buffer = page.threads
            .map((item) => {
              loaded.set(mailboxId(a.id, item.id), item);
              return {
                id: item.id,
                historyId: item.historyId || null,
                receivedOn: String((item.$raw as any)?.receivedOn || ''),
              };
            })
            .sort(
              (a, b) =>
                new Date(b.receivedOn || 0).getTime() - new Date(a.receivedOn || 0).getTime(),
            );
          states[a.id] = { buffer, next: page.nextPageToken || null };
        } catch (error) {
          states[a.id] = { buffer: [], next: null };
          warnings.push({
            accountId: a.id,
            email: a.email,
            message: 'Mailbox unavailable. Refresh to retry or check its connection settings.',
            code: mailboxFailure(error),
          });
        }
      }
      await Promise.all(accounts.map(fill));
      const threads: (IGetThreadsResponse['threads'][number] & {
        accountId: string;
        accountEmail: string;
      })[] = [];
      while (threads.length < input.maxResults) {
        const candidates = accounts
          .filter((a) => states[a.id]?.buffer.length)
          .sort(
            (a, b) =>
              new Date(states[b.id]!.buffer[0]!.receivedOn || 0).getTime() -
              new Date(states[a.id]!.buffer[0]!.receivedOn || 0).getTime(),
          );
        const a = candidates[0];
        if (!a) break;
        const item = states[a.id]!.buffer.shift()!;
        const encoded = mailboxId(a.id, item.id);
        let full = loaded.get(encoded);
        if (!full) {
          // Only IDs and dates are carried in cursors; resolve the selected preview under its owner.
          try {
            if (input.folder === 'draft') {
              const draft = await unifiedDraftsRouter.createCaller(ctx).get({ id: encoded });
              full = { ...item, $raw: { receivedOn: item.receivedOn, draftPreview: draft } };
            } else {
              const preview = await bounded(getMail(ctx, encoded));
              full = { ...item, $raw: { receivedOn: item.receivedOn, preview } };
            }
          } catch {
            warnings.push({
              accountId: a.id,
              email: a.email,
              message: 'A message could not be loaded.',
            });
            full = { ...item, $raw: { receivedOn: item.receivedOn } };
          }
        }
        threads.push({ ...full, id: encoded, accountId: a.id, accountEmail: a.email });
        if (threads.length < input.maxResults) await fill(a);
      }
      const currentStates = Object.fromEntries(
        accounts.map((a) => [a.id, states[a.id] || { buffer: [], next: null }]),
      );
      return {
        threads,
        warnings,
        nextPageToken: Object.values(currentStates).some(
          (state) => state.buffer.length || state.next,
        )
          ? JSON.stringify({ version: 2, scope: signature, states: currentStates })
          : null,
      };
    }),
  getEmailAliases: owned.input(scope.optional()).query(async ({ ctx, input }) => {
    const a = await ownedMailbox(ctx.sessionUser.id, input?.accountId);
    if (a.providerId === 'imap') return [{ email: a.email, name: a.name, primary: true }];
    return legacyMail.createCaller(await oauth(ctx, a)).getEmailAliases();
  }),
  suggestRecipients: owned
    .input(scope.extend({ query: z.string(), limit: z.number().optional() }))
    .query(async ({ ctx, input }): Promise<MailOutputs['suggestRecipients']> => {
      const accounts = await mailboxAccounts(ctx.sessionUser.id);
      const a = accounts.find((a) => a.id === input.accountId);
      if (!a || a.providerId === 'imap') return [] as unknown as MailOutputs['suggestRecipients'];
      return legacyMail.createCaller(await oauth(ctx, a)).suggestRecipients(input);
    }),
  markAsRead: owned.input(ids).mutation(({ ctx, input }) => modify(ctx, input.ids, [], ['UNREAD'])),
  markAsUnread: owned
    .input(ids)
    .mutation(({ ctx, input }) => modify(ctx, input.ids, ['UNREAD'], [])),
  markAsImportant: owned
    .input(ids)
    .mutation(({ ctx, input }) => modify(ctx, input.ids, ['IMPORTANT'], [])),
  bulkMarkImportant: owned
    .input(ids)
    .mutation(({ ctx, input }) => modify(ctx, input.ids, ['IMPORTANT'], [])),
  bulkUnmarkImportant: owned
    .input(ids)
    .mutation(({ ctx, input }) => modify(ctx, input.ids, [], ['IMPORTANT'])),
  bulkStar: owned.input(ids).mutation(({ ctx, input }) => modify(ctx, input.ids, ['STARRED'], [])),
  bulkUnstar: owned
    .input(ids)
    .mutation(({ ctx, input }) => modify(ctx, input.ids, [], ['STARRED'])),
  delete: owned.input(single).mutation(({ ctx, input }) => modify(ctx, [input.id], ['TRASH'], [])),
  bulkDelete: owned.input(ids).mutation(({ ctx, input }) => modify(ctx, input.ids, ['TRASH'], [])),
  bulkArchive: owned
    .input(ids)
    .mutation(({ ctx, input }) => modify(ctx, input.ids, ['ARCHIVE'], ['INBOX'])),
  modifyLabels: owned
    .input(
      z.object({
        threadId: z.array(id),
        addLabels: z.array(z.string()),
        removeLabels: z.array(z.string()),
      }),
    )
    .mutation(({ ctx, input }) => modify(ctx, input.threadId, input.addLabels, input.removeLabels)),
  toggleStar: owned.input(ids).mutation(async ({ ctx, input }) => {
    for (const id of input.ids) {
      const mail = await getMail(ctx, id);
      const starred = mail.labels.some((l) => l.name === 'STARRED');
      await modify(ctx, [id], starred ? [] : ['STARRED'], starred ? ['STARRED'] : []);
    }
    return { success: true };
  }),
  toggleImportant: owned.input(ids).mutation(async ({ ctx, input }) => {
    for (const id of input.ids) {
      const mail = await getMail(ctx, id);
      const important = mail.labels.some((l) => l.name === 'IMPORTANT');
      await modify(ctx, [id], important ? [] : ['IMPORTANT'], important ? ['IMPORTANT'] : []);
    }
    return { success: true };
  }),
  snoozeThreads: owned
    .input(ids.extend({ wakeAt: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const selected = await groups(ctx, input.ids);
      if (selected.some((g) => g.account.providerId === 'imap'))
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Snooze is available for OAuth mailboxes only.',
        });
      for (const g of selected) {
        const result = await legacyMail
          .createCaller(await oauth(ctx, g.account))
          .snoozeThreads({ ids: g.ids, wakeAt: input.wakeAt });
        if (!result.success) return result;
      }
      return { success: true };
    }),
  unsnoozeThreads: owned.input(ids).mutation(async ({ ctx, input }) => {
    const selected = await groups(ctx, input.ids);
    if (selected.some((g) => g.account.providerId === 'imap'))
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Snooze is available for OAuth mailboxes only.',
      });
    for (const g of selected)
      await legacyMail.createCaller(await oauth(ctx, g.account)).unsnoozeThreads({ ids: g.ids });
    return { success: true };
  }),
  verifyEmail: owned.input(single).query(async ({ ctx, input }) => {
    const { account: a, id } = await target(ctx, input.id);
    if (a.providerId !== 'imap')
      return legacyMail.createCaller(await oauth(ctx, a)).verifyEmail({ id });
    // No verification badge without verified provider evidence.
    return { isVerified: false };
  }),
  getMessageAttachments: owned
    .input(z.object({ messageId: id }))
    .query(async ({ ctx, input }): Promise<MailOutputs['getMessageAttachments']> => {
      const { account: a, id } = await target(ctx, input.messageId);
      if (a.providerId === 'imap') {
        const mail = await getMail(ctx, input.messageId);
        return (mail.latest?.attachments || []) as MailOutputs['getMessageAttachments'];
      }
      return legacyMail.createCaller(await oauth(ctx, a)).getMessageAttachments({ messageId: id });
    }),
  getRawEmail: owned.input(single).query(async ({ ctx, input }): Promise<string> => {
    const { account: a, id } = await target(ctx, input.id);
    if (a.providerId === 'imap')
      return imapBridge<string>(ctx.sessionUser.id, 'mail.raw', { accountId: a.id, id });
    return legacyMail.createCaller(await oauth(ctx, a)).getRawEmail({ id });
  }),
  send: owned
    .input(
      scope.extend({
        to: z.array(recipient),
        cc: z.array(recipient).optional(),
        bcc: z.array(recipient).optional(),
        subject: z.string(),
        message: z.string(),
        attachments: z.array(serializedFileSchema).default([]),
        headers: z.record(z.string()).default({}),
        threadId: id.optional(),
        draftId: id.optional(),
        fromEmail: z.string().optional(),
        isForward: z.boolean().optional(),
        originalMessage: z.string().optional(),
        scheduleAt: z.string().optional(),
        operationId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const a = await ownedMailbox(
        ctx.sessionUser.id,
        input.accountId || splitMailboxId(input.draftId || input.threadId || '')?.accountId,
      );
      const draft = input.draftId ? await target(ctx, input.draftId, a.id) : null;
      const thread = input.threadId ? await target(ctx, input.threadId, a.id) : null;
      if (a.providerId !== 'imap')
        return legacyMail
          .createCaller(await oauth(ctx, a))
          .send({ ...input, draftId: draft?.id, threadId: thread?.id });
      if (input.scheduleAt)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Scheduled sending is not available for this IMAP mailbox.',
        });
      // A stable operation ID survives an uncertain SMTP result; the bridge rejects changed payloads.
      const operationId =
        input.operationId ||
        Array.from(
          new Uint8Array(
            await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input))),
          ),
        )
          .map((x) => x.toString(16).padStart(2, '0'))
          .join('');
      const result = await imapBridge<ImapSendResult>(ctx.sessionUser.id, 'mail.send', {
        ...input,
        accountId: a.id,
        draftId: draft?.id,
        threadId: thread?.id,
        fromEmail: a.email,
        operationId,
      });
      return { success: true, messageId: result.id, sentCopySaved: result.sentCopySaved };
    }),
});
export const unifiedDraftsRouter = t.router({
  create: owned
    .input(createDraftData.extend({ accountId: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const a = await ownedMailbox(
        ctx.sessionUser.id,
        input.accountId || splitMailboxId(input.id || '')?.accountId,
      );
      const draft = input.id ? await target(ctx, input.id, a.id) : null;
      const thread = input.threadId ? await target(ctx, input.threadId, a.id) : null;
      const data = { ...input, id: draft?.id || null, threadId: thread?.id || null };
      const result =
        a.providerId === 'imap'
          ? await imapBridge<{ id: string }>(ctx.sessionUser.id, 'drafts.save', {
              ...data,
              accountId: a.id,
            })
          : await legacyDrafts.createCaller(await oauth(ctx, a)).create(data);
      if (!result?.id)
        throw new TRPCError({ code: 'BAD_GATEWAY', message: 'Draft save did not return an ID.' });
      return { id: mailboxId(a.id, result.id) };
    }),
  get: owned
    .input(single)
    .query(async ({ ctx, input }): Promise<ParsedDraft & { attachments?: unknown[] }> => {
      const { account: a, id } = await target(ctx, input.id);
      if (a.providerId !== 'imap') {
        const draft = await legacyDrafts.createCaller(await oauth(ctx, a)).get({ id });
        return { ...draft, id: mailboxId(a.id, id) };
      }
      const mail = await imapBridge<ImapThread>(ctx.sessionUser.id, 'mail.get', {
        accountId: a.id,
        id,
      });
      const latest = mail.latest!;
      if (!latest.isDraft)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'This message is not a draft.' });
      return {
        id: mailboxId(a.id, id),
        to: latest.to.map((a) => a.email),
        cc: latest.cc?.map((a) => a.email),
        bcc: latest.bcc?.map((a) => a.email),
        subject: latest.subject,
        content: latest.decodedBody,
        attachments: latest.attachments,
      };
    }),
  delete: owned.input(single).mutation(async ({ ctx, input }) => {
    const { account: a, id } = await target(ctx, input.id);
    if (a.providerId === 'imap')
      await imapBridge(ctx.sessionUser.id, 'drafts.delete', { accountId: a.id, id });
    else await legacyDrafts.createCaller(await oauth(ctx, a)).delete({ id });
    return true;
  }),
});
