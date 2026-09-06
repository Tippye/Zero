import { env } from '../../../env';
import { openai } from '../../../lib/openai';
import { activeDriverProcedure } from '../../trpc';
import { generateText } from 'ai';
import { z } from 'zod';

export const webSearch = activeDriverProcedure
  .input(z.object({ query: z.string() }))
  .mutation(async ({ input }) => {
    const result = await generateText({
      model: await openai(env.OPENAI_MODEL || 'gpt-4o'),
      system:
        'Answer using the information provided and your existing knowledge. You have no live web search tool; disclose when current information cannot be verified. Do not invent sources. NEVER use markdown formatting in your response.',
      messages: [{ role: 'user', content: input.query }],
      maxTokens: 1024,
    });
    return result;
  });
