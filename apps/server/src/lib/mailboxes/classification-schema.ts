import { z } from 'zod';

export const classificationSettingsSchema = z
  .object({
    concurrency: z.number().int().min(1).max(4),
    batch_size: z.number().int().min(1).max(50),
    interval_seconds: z.number().int().min(2).max(3600),
    timeout_seconds: z.number().int().min(5).max(120),
    recent_days: z.number().int().min(1).max(365),
    history_every_batches: z.number().int().min(1).max(100),
  })
  .strict();

export type ClassificationSettings = z.infer<typeof classificationSettingsSchema>;
