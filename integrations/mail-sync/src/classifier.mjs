import {
  nextPriority,
  resourceLimits,
  classificationLimits,
  MAX_CLASSIFICATION_CONCURRENCY,
} from './limits.mjs';
import { classifyAccount } from './classify.mjs';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';

// Separate process, pool and advisory lock: AI cannot consume sync worker slots.
export async function main(config = process.env) {
  const limits = resourceLimits(config);
  const sql = postgres(config.DATABASE_URL, {
    max: MAX_CLASSIFICATION_CONCURRENCY + 2,
    connect_timeout: 5,
    idle_timeout: 10,
  });
  const lock = await sql.reserve();
  // 1 is the sync worker and 2 is reserved for database migrations.
  if (!(await lock`SELECT pg_try_advisory_lock(20260906,3) AS acquired`)[0].acquired)
    throw new Error('Classifier already running');
  let stopped = false;
  const batches = new Map();
  const active = new Map();
  const stop = () => {
    stopped = true;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  console.log('Isolated mail classifier started', JSON.stringify(limits));
  try {
    while (!stopped) {
      try {
        await sql`INSERT INTO mail0_classifier_health VALUES(1,now()) ON CONFLICT(id) DO UPDATE SET heartbeat_at=excluded.heartbeat_at`;
        if (active.size < MAX_CLASSIFICATION_CONCURRENCY) {
          const owners =
            await sql`SELECT pending.user_id,to_jsonb(s) AS settings FROM (SELECT user_id,min(classification_retry_at) AS due FROM mail0_sync_accounts WHERE NOT classification_paused GROUP BY user_id) pending LEFT JOIN mail0_classification_settings s ON s.user_id=pending.user_id ORDER BY pending.due,pending.user_id LIMIT 100`;
          const present = new Set(owners.map((owner) => owner.user_id));
          for (const owner of batches.keys()) if (!present.has(owner)) batches.delete(owner);
          for (const owner of owners) {
            const current = classificationLimits(config, owner.settings);
            const running = [...active.values()].filter(
              (entry) => entry.owner === owner.user_id,
            ).length;
            if (running >= current.aiAccounts) continue;
            const batch = batches.get(owner.user_id) || 0;
            const priority = nextPriority(batch, current);
            const accounts =
              await sql`SELECT user_id,account_id FROM mail0_sync_accounts a WHERE user_id=${owner.user_id} AND NOT classification_paused AND classification_retry_at<=now() AND EXISTS(SELECT 1 FROM mail0_cached_mail c WHERE c.user_id=a.user_id AND c.account_id=a.account_id AND c.kind='mail' AND 'inbox'=ANY(c.folders) AND NOT EXISTS(SELECT 1 FROM mail0_category_feedback f WHERE f.user_id=c.user_id AND f.account_id=c.account_id AND f.native_id=c.native_id) AND (c.ai_category IS NULL OR c.ai_source_hash IS DISTINCT FROM md5(c.search_text))) ORDER BY CASE WHEN ${priority === 'recent'} THEN EXISTS(SELECT 1 FROM mail0_cached_mail c WHERE c.user_id=a.user_id AND c.account_id=a.account_id AND c.kind='mail' AND 'inbox'=ANY(c.folders) AND c.received_at>now()-${current.recentDays}*interval '1 day' AND NOT EXISTS(SELECT 1 FROM mail0_category_feedback f WHERE f.user_id=c.user_id AND f.account_id=c.account_id AND f.native_id=c.native_id) AND (c.ai_category IS NULL OR c.ai_source_hash IS DISTINCT FROM md5(c.search_text))) ELSE false END DESC,classification_retry_at,account_id LIMIT 5`;
            const account = accounts.find(
              (a) => !active.has(JSON.stringify([a.user_id, a.account_id])),
            );
            if (!account) continue;
            const key = JSON.stringify([account.user_id, account.account_id]);
            batches.set(owner.user_id, batch + 1);
            const task = classifyAccount(sql, config, account, fetch, priority)
              .catch(() => console.warn('Classification database operation deferred'))
              .finally(() => active.delete(key));
            active.set(key, { owner: owner.user_id, task });
            // Read settings again before the next admission, including lowered concurrency.
            break;
          }
        }
      } catch {
        console.warn('Classifier scheduler will retry after a local service failure');
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    await Promise.allSettled([...active.values()].map((entry) => entry.task));
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    await lock.release();
    await sql.end({ timeout: 5 });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error('Classifier startup failed; check resource and database configuration');
    process.exitCode = 1;
  });
