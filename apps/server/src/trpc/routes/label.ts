import { activeDriverProcedure, createRateLimiterMiddleware, router } from '../trpc';
import { getZeroAgent } from '../../lib/server-utils';
import { Ratelimit } from '@upstash/ratelimit';
import { z } from 'zod';

export const labelsRouter = router({
  list: activeDriverProcedure
    .input(z.object({ accountId: z.string().optional() }).optional())
    .use(
      createRateLimiterMiddleware({
        generatePrefix: ({ sessionUser }) => `ratelimit:get-labels-${sessionUser?.id}`,
        limiter: Ratelimit.slidingWindow(120, '1m'),
      }),
    )
    .output(
      z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          color: z
            .object({
              backgroundColor: z.string(),
              textColor: z.string(),
            })
            .optional(),
          type: z.string(),
        }),
      ),
    )
    .query(async ({ ctx }) => {
      const { activeConnection } = ctx;
      const { stub: agent } = await getZeroAgent(activeConnection.id);
      return await agent.getUserLabels();
    }),
  create: activeDriverProcedure
    .use(
      createRateLimiterMiddleware({
        generatePrefix: ({ sessionUser }) => `ratelimit:labels-post-${sessionUser?.id}`,
        limiter: Ratelimit.slidingWindow(60, '1m'),
      }),
    )
    .input(
      z.object({
        accountId: z.string().optional(),
        name: z.string(),
        color: z
          .object({
            backgroundColor: z.string(),
            textColor: z.string(),
          })
          .default({
            backgroundColor: '',
            textColor: '',
          }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { activeConnection } = ctx;
      const { stub: agent } = await getZeroAgent(activeConnection.id);
      const { accountId: _scope, ...data } = input;
      const label = {
        ...data,
        type: 'user',
      };
      return await agent.createLabel(label);
    }),
  update: activeDriverProcedure
    .use(
      createRateLimiterMiddleware({
        generatePrefix: ({ sessionUser }) => `ratelimit:labels-patch-${sessionUser?.id}`,
        limiter: Ratelimit.slidingWindow(60, '1m'),
      }),
    )
    .input(
      z.object({
        accountId: z.string().optional(),
        id: z.string(),
        name: z.string(),
        type: z.string().optional(),
        color: z
          .object({
            backgroundColor: z.string(),
            textColor: z.string(),
          })
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { activeConnection } = ctx;
      const { stub: agent } = await getZeroAgent(activeConnection.id);
      const { id, accountId: _scope, ...label } = input;
      return await agent.updateLabel(id, label);
    }),
  delete: activeDriverProcedure
    .use(
      createRateLimiterMiddleware({
        generatePrefix: ({ sessionUser }) => `ratelimit:labels-delete-${sessionUser?.id}`,
        limiter: Ratelimit.slidingWindow(60, '1m'),
      }),
    )
    .input(z.object({ id: z.string(), accountId: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const { activeConnection } = ctx;
      const { stub: agent } = await getZeroAgent(activeConnection.id);
      return await agent.deleteLabel(input.id);
    }),
});
