import { router, privateProcedure } from '../trpc';
import { getBimi } from '../../lib/bimi';
import { z } from 'zod';

const resultSchema = z.object({
  domain: z.string(),
  bimiRecord: z
    .object({
      version: z.string().optional(),
      logoUrl: z.string().optional(),
      authorityUrl: z.string().optional(),
    })
    .nullable(),
  logo: z.object({ url: z.string(), svgContent: z.string() }).nullable(),
});

export const bimiRouter = router({
  getByEmail: privateProcedure
    .input(z.object({ email: z.string().email() }))
    .output(resultSchema)
    .query(({ input }) => getBimi(input.email.split('@')[1]!)),
  getByDomain: privateProcedure
    .input(
      z.object({
        domain: z
          .string()
          .trim()
          .toLowerCase()
          .max(253)
          .regex(
            /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
          ),
      }),
    )
    .output(resultSchema)
    .query(({ input }) => getBimi(input.domain)),
});
