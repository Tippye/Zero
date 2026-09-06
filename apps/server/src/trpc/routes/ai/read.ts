import {
  translationDocument,
  translationBatches,
  translationMessages,
  parseTranslation,
} from '../../../lib/mail-translation';
import {
  getTranslation,
  saveTranslation,
  translationSourceHash,
} from '../../../lib/mailboxes/translations';
import { readerInput, readerMessages } from '../../../lib/mail-reader-ai';
import { splitMailboxId } from '../../../lib/mailboxes/ids';
import { unifiedMailRouter } from '../mailboxes';
import { privateProcedure } from '../../trpc';
import { openai } from '../../../lib/openai';
import { TRPCError } from '@trpc/server';
import { generateText } from 'ai';
import { z } from 'zod';

export const read = privateProcedure.input(readerInput).mutation(async ({ ctx, input }) => {
  // The unified reader checks mailbox ownership and supports both IMAP and OAuth.
  const thread = await unifiedMailRouter.createCaller(ctx).get({ id: input.threadId });
  const message = thread.messages.find((message) => message.id === input.messageId);
  if (!message) throw new TRPCError({ code: 'NOT_FOUND', message: 'MAIL_AI_MESSAGE_NOT_FOUND' });
  if (input.action === 'translate') {
    const key = await translationKey(
      ctx.sessionUser.id,
      input.threadId,
      message.id,
      message.subject || '',
      message.decodedBody || '',
    );
    const cached = await getTranslation(key, input.language);
    if (cached) return { text: '', translation: cached };
    try {
      const document = translationDocument(message.decodedBody || '', message.subject || '');
      const model = await openai('', { ownerId: ctx.sessionUser.id });
      const abortSignal = AbortSignal.any([ctx.c.req.raw.signal, AbortSignal.timeout(120000)]);
      const translations = [];
      for (const batch of translationBatches(document.segments)) {
        const result = await generateText({
          model,
          messages: translationMessages(input.language, batch),
          maxTokens: 8192,
          maxRetries: 1,
          abortSignal,
        });
        if (result.finishReason === 'length') throw new Error('MAIL_AI_OUTPUT_TOO_LONG');
        translations.push(...parseTranslation(result.text, batch));
      }
      abortSignal.throwIfAborted();
      const translation = await saveTranslation(key, input.language, document.apply(translations));
      if (!translation) throw new Error('MAIL_AI_FAILED');
      return { text: '', translation };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: ['MAIL_AI_EMPTY', 'MAIL_AI_TOO_LONG', 'MAIL_AI_OUTPUT_TOO_LONG'].includes(code)
          ? code
          : 'MAIL_AI_FAILED',
      });
    }
  }
  let messages;
  try {
    messages = readerMessages(input, {
      subject: message.subject || '',
      from: message.sender.email,
      body: message.decodedBody || '',
    });
  } catch (error) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: (error as Error).message });
  }
  const model = await openai('', { ownerId: ctx.sessionUser.id });
  try {
    const result = await generateText({
      model,
      messages,
      maxTokens: 8192,
      maxRetries: 1,
      abortSignal: AbortSignal.any([ctx.c.req.raw.signal, AbortSignal.timeout(60000)]),
    });
    if (result.finishReason === 'length') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'MAIL_AI_OUTPUT_TOO_LONG' });
    }
    if (!result.text.trim()) throw new Error('Empty model response');
    return { text: result.text, translation: null };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    // Provider errors can contain request details; do not expose them to the UI.
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'MAIL_AI_FAILED' });
  }
});

const translationInput = z.object({
  threadId: z.string().min(1).max(16000),
  messageId: z.string().min(1).max(16000),
});
async function translationKey(
  owner: string,
  threadId: string,
  messageId: string,
  subject: string,
  body: string,
) {
  const message = splitMailboxId(messageId);
  if (!message) throw new TRPCError({ code: 'BAD_REQUEST', message: 'MAIL_AI_MESSAGE_NOT_FOUND' });
  return {
    owner,
    account: message.accountId,
    thread: splitMailboxId(threadId)?.id || threadId,
    message: message.id,
    sourceHash: await translationSourceHash(subject, body),
  };
}

export const translation = privateProcedure
  .input(translationInput)
  .query(async ({ ctx, input }) => {
    const thread = await unifiedMailRouter.createCaller(ctx).get({ id: input.threadId });
    const message = thread.messages.find((message) => message.id === input.messageId);
    if (!message) throw new TRPCError({ code: 'NOT_FOUND', message: 'MAIL_AI_MESSAGE_NOT_FOUND' });
    return getTranslation(
      await translationKey(
        ctx.sessionUser.id,
        input.threadId,
        message.id,
        message.subject || '',
        message.decodedBody || '',
      ),
    );
  });
