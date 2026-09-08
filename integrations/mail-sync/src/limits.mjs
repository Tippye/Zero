export function integer(config, name, fallback, min, max) {
  const value = config[name] === undefined || config[name] === '' ? fallback : Number(config[name]);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

export function resourceLimits(config = {}) {
  return {
    syncAccounts: integer(config, 'SYNC_ACCOUNT_CONCURRENCY', 1, 1, 4),
    syncMessages: integer(config, 'SYNC_MESSAGE_CONCURRENCY', 2, 1, 8),
    aiAccounts: integer(config, 'AI_CLASSIFY_CONCURRENCY', 1, 1, 4),
    batchSize: integer(config, 'AI_CLASSIFY_BATCH_SIZE', 10, 1, 50),
    intervalSeconds: integer(config, 'AI_CLASSIFY_INTERVAL_SECONDS', 10, 2, 3600),
    timeoutMs: integer(config, 'AI_CLASSIFY_TIMEOUT_SECONDS', 60, 5, 120) * 1000,
    recentDays: integer(config, 'AI_RECENT_DAYS', 7, 1, 365),
    historyEvery: integer(config, 'AI_HISTORY_EVERY_BATCHES', 5, 1, 100),
  };
}

export function nextPriority(batch, limits) {
  return (batch + 1) % limits.historyEvery === 0 ? 'oldest' : 'recent';
}

export const MAX_CLASSIFICATION_CONCURRENCY = 4;

// Deployment values supply defaults; persisted workspace settings override them.
export function classificationLimits(config = {}, settings) {
  if (!settings) return resourceLimits(config);
  return resourceLimits({
    ...config,
    AI_CLASSIFY_CONCURRENCY: settings.concurrency,
    AI_CLASSIFY_BATCH_SIZE: settings.batch_size,
    AI_CLASSIFY_INTERVAL_SECONDS: settings.interval_seconds,
    AI_CLASSIFY_TIMEOUT_SECONDS: settings.timeout_seconds,
    AI_RECENT_DAYS: settings.recent_days,
    AI_HISTORY_EVERY_BATCHES: settings.history_every_batches,
  });
}

export async function loadClassificationLimits(sql, config, owner) {
  const [settings] =
    await sql`SELECT concurrency,batch_size,interval_seconds,timeout_seconds,recent_days,history_every_batches FROM mail0_classification_settings WHERE user_id=${owner}`;
  return classificationLimits(config, settings);
}
