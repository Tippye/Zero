import { syncEnabled, withDb } from './cache';
import { TRPCError } from '@trpc/server';
import { env } from '../../env';
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

function defaultSettings() {
  return classificationSettingsSchema.parse({
    concurrency: Number(env.AI_CLASSIFY_CONCURRENCY || 1),
    batch_size: Number(env.AI_CLASSIFY_BATCH_SIZE || 10),
    interval_seconds: Number(env.AI_CLASSIFY_INTERVAL_SECONDS || 10),
    timeout_seconds: Number(env.AI_CLASSIFY_TIMEOUT_SECONDS || 60),
    recent_days: Number(env.AI_RECENT_DAYS || 7),
    history_every_batches: Number(env.AI_HISTORY_EVERY_BATCHES || 5),
  });
}

export async function classificationSettings(owner: string) {
  const defaults = defaultSettings();
  if (!syncEnabled()) return { enabled: false, defaults, settings: defaults };
  return withDb(async (sql) => {
    const [saved] =
      await sql`SELECT concurrency,batch_size,interval_seconds,timeout_seconds,recent_days,history_every_batches FROM mail0_classification_settings WHERE user_id=${owner}`;
    return {
      enabled: true,
      defaults,
      settings: saved ? classificationSettingsSchema.parse(saved) : defaults,
    };
  });
}

export async function saveClassificationSettings(
  owner: string,
  input: z.infer<typeof classificationSettingsSchema>,
) {
  if (!syncEnabled()) throw new TRPCError({ code: 'PRECONDITION_FAILED' });
  const settings = classificationSettingsSchema.parse(input);
  await withDb((sql) =>
    sql.begin(async (tx) => {
      await tx`INSERT INTO mail0_classification_settings(user_id,concurrency,batch_size,interval_seconds,timeout_seconds,recent_days,history_every_batches) VALUES(${owner},${settings.concurrency},${settings.batch_size},${settings.interval_seconds},${settings.timeout_seconds},${settings.recent_days},${settings.history_every_batches}) ON CONFLICT(user_id) DO UPDATE SET concurrency=excluded.concurrency,batch_size=excluded.batch_size,interval_seconds=excluded.interval_seconds,timeout_seconds=excluded.timeout_seconds,recent_days=excluded.recent_days,history_every_batches=excluded.history_every_batches`;
      // Keep pause state, completed classifications and provider error backoff intact.
      // Running batches finish normally; the next admission reads the saved limits.
      await tx`UPDATE mail0_sync_accounts SET classification_batch_size=${settings.batch_size},classification_retry_at=CASE WHEN classification_error IS NULL AND classification_updated_at IS NOT NULL THEN greatest(now(),classification_updated_at+${settings.interval_seconds}*interval '1 second') ELSE classification_retry_at END WHERE user_id=${owner}`;
    }),
  );
  return { success: true, settings };
}
