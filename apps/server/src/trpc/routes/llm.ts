import {
  changeLlmState,
  environmentProfile,
  llmOverview,
  normalizeLlmUrl,
  readLlmState,
  revealKey,
  sealKey,
} from '../../lib/llm-settings';
import { requestClassification } from '../../lib/mailboxes/cache';
import { requestLlmJson, testLlmModel } from '../../lib/llm-http';
import type { HonoContext, HonoVariables } from '../../ctx';
import { initTRPC, TRPCError } from '@trpc/server';
import type { Context } from 'hono';
import superjson from 'superjson';
import { env } from '../../env';
import { z } from 'zod';

// Credentials must bypass the normal input-logging middleware.
const t = initTRPC
  .context<{ c: Context<HonoContext> } & HonoVariables>()
  .create({ transformer: superjson });
const owned = t.procedure.use(({ ctx, next }) => {
  if (!ctx.sessionUser) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { ...ctx, sessionUser: ctx.sessionUser } });
});
const id = z.string().uuid();
const config = z
  .object({
    id: id.optional(),
    name: z.string().trim().min(1).max(100),
    baseUrl: z.string().max(2048),
    apiKey: z.string().trim().max(4096).optional(),
    model: z.string().trim().min(1).max(256),
    miniModel: z.string().trim().max(256).default(''),
    embeddingModel: z.string().trim().max(256).default(''),
    activate: z.boolean().default(false),
  })
  .strict();
const probeConfig = z
  .object({
    id: z.union([id, z.literal('environment')]).optional(),
    baseUrl: z.string().max(2048).optional(),
    apiKey: z.string().trim().max(4096).optional(),
  })
  .strict();
async function resolveProbe(
  ownerId: string,
  input: z.infer<typeof probeConfig> & { model?: string },
) {
  let baseUrl: string,
    apiKey: string,
    model = input.model || '';
  if (input.id === 'environment') {
    const profile = environmentProfile();
    if (!profile) throw new TRPCError({ code: 'NOT_FOUND' });
    baseUrl = normalizeLlmUrl(profile.baseUrl);
    apiKey = env.OPENAI_API_KEY;
    model ||= profile.model;
  } else {
    const state = await readLlmState(ownerId),
      profile = state.profiles.find((p) => p.id === input.id);
    if (input.id && !profile) throw new TRPCError({ code: 'NOT_FOUND' });
    baseUrl = normalizeLlmUrl(input.baseUrl || profile?.baseUrl || '');
    if (!input.apiKey && (!profile || profile.baseUrl !== baseUrl))
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'LLM_KEY_REQUIRED' });
    apiKey = input.apiKey || (await revealKey(profile!, ownerId));
    model ||= profile?.model || '';
  }
  return { baseUrl, apiKey, model };
}
const loopbackHost = () => (env.SELF_HOSTED === 'true' ? env.LLM_LOOPBACK_HOST : undefined);
export const llmRouter = t.router({
  list: owned.query(({ ctx }) => llmOverview(ctx.sessionUser.id)),
  save: owned.input(config).mutation(async ({ ctx, input }) => {
    const ownerId = ctx.sessionUser.id,
      profileId = input.id || crypto.randomUUID(),
      baseUrl = normalizeLlmUrl(input.baseUrl);
    await changeLlmState(ownerId, async (state) => {
      const existing = state.profiles.find((p) => p.id === profileId);
      if (input.id && !existing) throw new TRPCError({ code: 'NOT_FOUND' });
      if (!existing && state.profiles.length >= 20)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'LLM_PROFILE_LIMIT' });
      if (!input.apiKey && (!existing || existing.baseUrl !== baseUrl))
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'LLM_KEY_REQUIRED' });
      const encryptedKey = input.apiKey
        ? await sealKey(input.apiKey, ownerId, profileId)
        : existing!.encryptedKey;
      const profile = {
        id: profileId,
        name: input.name,
        baseUrl,
        model: input.model,
        miniModel: input.miniModel,
        embeddingModel: input.embeddingModel,
        encryptedKey,
      };
      return {
        profiles: [...state.profiles.filter((p) => p.id !== profileId), profile],
        activeId: input.activate ? profileId : state.activeId,
      };
    });
    await requestClassification(ownerId).catch(() => {});
    return { id: profileId };
  }),
  activate: owned
    .input(z.object({ id: z.union([id, z.literal('environment'), z.null()]) }).strict())
    .mutation(async ({ ctx, input }) => {
      await changeLlmState(ctx.sessionUser.id, (state) => {
        if (
          input.id &&
          !(input.id === 'environment'
            ? environmentProfile()
            : state.profiles.some((p) => p.id === input.id))
        )
          throw new TRPCError({ code: 'NOT_FOUND' });
        return { ...state, activeId: input.id };
      });
      await requestClassification(ctx.sessionUser.id).catch(() => {});
      return { success: true };
    }),
  remove: owned.input(z.object({ id }).strict()).mutation(async ({ ctx, input }) => {
    await changeLlmState(ctx.sessionUser.id, (state) => {
      if (!state.profiles.some((p) => p.id === input.id))
        throw new TRPCError({ code: 'NOT_FOUND' });
      return {
        profiles: state.profiles.filter((p) => p.id !== input.id),
        activeId: state.activeId === input.id ? null : state.activeId,
      };
    });
    await requestClassification(ctx.sessionUser.id).catch(() => {});
    return { success: true };
  }),
  models: owned.input(probeConfig).mutation(async ({ ctx, input }) => {
    const profile = await resolveProbe(ctx.sessionUser.id, input);
    const data = await requestLlmJson({ ...profile, path: 'models', loopbackHost: loopbackHost() });
    if (!Array.isArray(data?.data))
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'LLM_MODELS_UNSUPPORTED' });
    return {
      models: [
        ...new Set<string>(
          data.data
            .map((item: { id?: unknown }) => item?.id)
            .filter(
              (value: unknown): value is string =>
                typeof value === 'string' && value.length > 0 && value.length <= 256,
            ),
        ),
      ]
        .sort()
        .slice(0, 2000),
    };
  }),
  test: owned
    .input(probeConfig.extend({ model: z.string().trim().min(1).max(256).optional() }))
    .mutation(async ({ ctx, input }) => {
      const profile = await resolveProbe(ctx.sessionUser.id, input);
      if (!profile.model)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'LLM_MODEL_REQUIRED' });
      return testLlmModel(profile, loopbackHost());
    }),
});
