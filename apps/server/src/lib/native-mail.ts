import { mailboxId, splitMailboxId } from './mailboxes/ids';
import type { IGetThreadResponse } from './driver/types';
import type { inferRouterInputs } from '@trpc/server';
import { stripHtml } from 'string-strip-html';
import type { ParsedMessage } from '../types';
import { TRPCError } from '@trpc/server';
import type { AppRouter } from '../trpc';
import { z } from 'zod';

type Caller = ReturnType<AppRouter['createCaller']>;
const id = z.string().min(1).max(16000);
const single = z.object({ id });
const address = z.object({ email: z.string().email(), name: z.string().optional() });
const attachment = z
  .object({
    name: z
      .string()
      .min(1)
      .max(255)
      .refine((name) => !['\r', '\n', '\0'].some((character) => name.includes(character))),
    type: z
      .string()
      .max(255)
      .regex(/^[\w.+-]+\/[\w.+-]+$/),
    size: z
      .number()
      .int()
      .min(0)
      .max(15 * 1024 * 1024),
    lastModified: z.number(),
    base64: z.string().max(20 * 1024 * 1024),
  })
  .superRefine((file, ctx) => {
    try {
      if (atob(file.base64).length !== file.size) throw new Error('size');
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid attachment data' });
    }
  });
const outgoing = z.object({
  accountId: id,
  to: z.array(address).max(100),
  cc: z.array(address).max(100).default([]),
  bcc: z.array(address).max(100).default([]),
  subject: z.string().max(998),
  message: z.string().max(1000000),
  attachments: z
    .array(attachment)
    .max(20)
    .refine((files) => files.reduce((size, file) => size + file.size, 0) <= 15 * 1024 * 1024)
    .default([]),
  threadId: id.optional(),
  draftId: id.optional(),
  headers: z
    .object({
      'In-Reply-To': z.string().max(998).optional(),
      References: z.string().max(4000).optional(),
    })
    .default({}),
  operationId: z.string().uuid(),
});
const textBody = (html: string) => stripHtml(html).result;
type DraftPart = { filename?: string; body?: { attachmentId?: string }; parts?: DraftPart[] };
function draftAttachmentIds(part: DraftPart | undefined): string[] {
  if (!part) return [];
  return [
    ...(part.filename && part.body?.attachmentId ? [part.body.attachmentId] : []),
    ...(part.parts || []).flatMap(draftAttachmentIds),
  ];
}
function message(value: ParsedMessage) {
  const html = value.decodedBody || value.processedHtml || '';
  return {
    id: value.id,
    sender: value.sender,
    to: value.to || [],
    cc: value.cc || [],
    bcc: value.bcc || [],
    subject: value.subject || '',
    receivedOn: value.receivedOn || '',
    text: textBody(html),
    html,
    messageId: value.messageId,
    replyTo: value.replyTo,
    references: value.references,
    isDraft: !!value.isDraft,
    attachments: (value.attachments || []).map(({ attachmentId, filename, mimeType, size }) => ({
      attachmentId,
      filename,
      mimeType,
      size,
    })),
  };
}
export function nativeThread(id: string, value: IGetThreadResponse) {
  return {
    id,
    unread: value.hasUnread,
    starred: value.labels.some((l) => l.name === 'STARRED'),
    messages: value.messages.map(message),
  };
}

/** Versioned JSON boundary. Ownership and provider behavior stay in the unified routers. */
export async function nativeMail(
  caller: Caller,
  operation: string,
  body: unknown,
): Promise<unknown> {
  switch (operation) {
    case 'accounts':
      return { accounts: await caller.mailboxes.accounts() };
    case 'threads': {
      const input = z
        .object({
          accountId: id.optional(),
          folder: z
            .enum(['inbox', 'sent', 'draft', 'archive', 'spam', 'trash', 'starred'])
            .default('inbox'),
          q: z.string().max(2000).default(''),
          cursor: z.string().max(512000).default(''),
          maxResults: z.number().int().min(1).max(30).default(20),
        })
        .parse(body);
      const page = await caller.mail.listThreads({
        ...input,
        folder: input.folder === 'trash' ? 'bin' : input.folder,
        labelIds: [],
      });
      return {
        threads: page.threads.map((item) => {
          const raw = item.$raw as
            | {
                preview?: IGetThreadResponse;
                draftPreview?: { subject?: string };
                subject?: string;
                receivedOn?: string;
              }
            | undefined;
          const preview = raw?.preview;
          const latest = preview?.latest || preview?.messages.at(-1);
          return {
            id: item.id,
            accountId: item.accountId,
            accountEmail: item.accountEmail,
            subject: latest?.subject || raw?.draftPreview?.subject || raw?.subject || '',
            sender: latest?.sender || { email: '', name: '' },
            receivedOn: latest?.receivedOn || raw?.receivedOn || '',
            snippet: textBody(latest?.decodedBody || latest?.processedHtml || '').slice(0, 240),
            unread: !!preview?.hasUnread,
            starred: !!preview?.labels.some((l) => l.name === 'STARRED'),
            isDraft: input.folder === 'draft',
          };
        }),
        cursor: page.nextPageToken,
        warnings: page.warnings || [],
      };
    }
    case 'thread': {
      const { id } = single.parse(body);
      return nativeThread(id, await caller.mail.get({ id }));
    }
    case 'attachments': {
      const { id } = single.parse(body);
      return { attachments: await caller.mail.getMessageAttachments({ messageId: id }) };
    }
    case 'action': {
      const input = z
        .object({
          ids: z.array(id).min(1).max(100),
          action: z.enum(['read', 'unread', 'star', 'unstar', 'archive', 'trash']),
        })
        .parse(body);
      const handlers = {
        read: caller.mail.markAsRead,
        unread: caller.mail.markAsUnread,
        star: caller.mail.bulkStar,
        unstar: caller.mail.bulkUnstar,
        archive: caller.mail.bulkArchive,
        trash: caller.mail.bulkDelete,
      };
      return handlers[input.action]({ ids: input.ids });
    }
    case 'send': {
      const input = outgoing.parse(body);
      if (!input.to.length && !input.cc.length && !input.bcc.length)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Recipient required' });
      return caller.mail.send(input);
    }
    case 'save-draft': {
      const input = outgoing.parse(body);
      const data: inferRouterInputs<AppRouter>['drafts']['create'] = {
        accountId: input.accountId,
        id: input.draftId || null,
        threadId: input.threadId || null,
        fromEmail: null,
        to: input.to.map((a) => a.email).join(', '),
        cc: input.cc.map((a) => a.email).join(', '),
        bcc: input.bcc.map((a) => a.email).join(', '),
        subject: input.subject,
        message: input.message,
        attachments: input.attachments,
      };
      return caller.drafts.create(data);
    }
    case 'draft': {
      const draft = await caller.drafts.get(single.parse(body));
      const account = splitMailboxId(draft.id);
      const raw = draft.rawMessage as { id?: string; payload?: DraftPart } | undefined;
      // Gmail draft IDs differ from message IDs. Resolve the latter from the owned draft.
      const attachments =
        account && raw?.id
          ? await caller.mail.getMessageAttachments({
              messageId: mailboxId(account.accountId, raw.id),
            })
          : draft.attachments || [];
      const loaded = new Set(
        attachments.map((file) => (file as { attachmentId: string }).attachmentId),
      );
      // Do not let a partial provider download (including inline images) become a destructive draft save.
      if (draftAttachmentIds(raw?.payload).some((id) => !loaded.has(id)))
        throw new TRPCError({ code: 'BAD_GATEWAY', message: 'Draft attachments are incomplete.' });
      return {
        id: draft.id,
        to: draft.to || [],
        cc: draft.cc || [],
        bcc: draft.bcc || [],
        subject: draft.subject || '',
        content: draft.content || '',
        attachments,
        text: textBody(draft.content || ''),
      };
    }
    case 'delete-draft':
      return { success: await caller.drafts.delete(single.parse(body)) };
    case 'sync':
      return caller.mailboxes.syncNow(z.object({ accountId: id.optional() }).parse(body));
    default:
      throw new TRPCError({ code: 'NOT_FOUND' });
  }
}
