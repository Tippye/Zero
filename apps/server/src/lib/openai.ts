import { resolveLlm, type LlmIdentity } from './llm-settings';
import { createOpenAI } from '@ai-sdk/openai';
import { llmRequestUrl } from './llm-http';
import { env } from '../env';

export function configuredOpenAI(profile: { apiKey: string; baseUrl: string }) {
  return createOpenAI({
    apiKey: profile.apiKey,
    baseURL: profile.baseUrl,
    compatibility: 'compatible',
    fetch: async (url, options) => {
      const response = await fetch(
        llmRequestUrl(url, env.SELF_HOSTED === 'true' ? env.LLM_LOOPBACK_HOST : undefined),
        {
          ...options,
          redirect: 'manual',
          signal: AbortSignal.any([
            ...(options?.signal ? [options.signal] : []),
            AbortSignal.timeout(60000),
          ]),
        },
      );
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error('LLM_REDIRECT_DISABLED');
      }
      return response;
    },
  });
}

export async function openai(
  _legacyModel: string,
  identity?: LlmIdentity,
  variant: 'main' | 'mini' = 'main',
) {
  const profile = await resolveLlm(identity);
  return configuredOpenAI(profile)(
    variant === 'mini' ? profile.miniModel || profile.model : profile.model,
  );
}
