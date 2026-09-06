import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { resolve } from 'node:path';

const spec = JSON.parse(await readFile(new URL('./bindings.json', import.meta.url)));
const names = [
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'PUBLIC_URL',
  'AUTH_ORIGINS',
  'REDIS_URL',
  'REDIS_TOKEN',
  'IMAP_BRIDGE_URL',
  'IMAP_BRIDGE_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'LLM_LOOPBACK_HOST',
  'OPENAI_MODEL',
  'OPENAI_MINI_MODEL',
  'OPENAI_EMBEDDING_MODEL',
];
const bindings = Object.fromEntries(names.map((name) => [name, process.env[name] || '']));
for (const name of [
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'PUBLIC_URL',
  'REDIS_URL',
  'REDIS_TOKEN',
  'IMAP_BRIDGE_SECRET',
]) {
  if (!bindings[name]) throw new Error(`Required configuration missing: ${name}`);
}
const origin = new URL(bindings.PUBLIC_URL).origin;
Object.assign(bindings, {
  SELF_HOSTED: 'true',
  SELF_HOSTED_AUTH: 'required',
  MAIL_SYNC_ENABLED: 'true',
  NODE_ENV: 'production',
  VITE_PUBLIC_APP_URL: origin,
  VITE_PUBLIC_BACKEND_URL: origin,
  BETTER_AUTH_URL: origin,
  AUTH_ORIGINS: bindings.AUTH_ORIGINS || origin,
  DISABLE_WORKFLOWS: 'true',
  GOOGLE_S_ACCOUNT: '{}',
  ENABLE_MEET: 'false',
  THREAD_SYNC_LOOP: 'false',
  THREAD_SYNC_MAX_COUNT: '50',
  DROP_AGENT_TABLES: 'false',
});
const data = process.env.DATA_DIR || '/data';
const mf = new Miniflare({
  name: 'zero',
  host: '0.0.0.0',
  port: Number(process.env.PORT || 8787),
  modules: true,
  scriptPath: resolve(process.env.WORKER_PATH || '/app/worker/main.js'),
  modulesRules: [{ type: 'Text', include: ['**/*.sql'], fallthrough: true }],
  compatibilityDate: '2025-05-01',
  compatibilityFlags: ['nodejs_compat'],
  bindings,
  cf: false,
  hyperdrives: { HYPERDRIVE: bindings.DATABASE_URL },
  durableObjects: Object.fromEntries(
    Object.entries(spec.objects).map(([key, className]) => [key, { className, useSQLite: true }]),
  ),
  durableObjectsPersist: `${data}/objects`,
  kvNamespaces: spec.kv,
  kvPersist: `${data}/kv`,
  r2Buckets: ['THREADS_BUCKET'],
  r2Persist: `${data}/r2`,
  workflows: spec.workflows,
  workflowsPersist: `${data}/workflows`,
  queueProducers: {
    thread_queue: 'thread-queue',
    subscribe_queue: 'subscribe-queue',
    send_email_queue: 'send-email-queue',
  },
  queueConsumers: ['thread-queue', 'subscribe-queue', 'send-email-queue'],
});
await mf.ready;
console.log('Zero self-hosted API ready');
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await mf.dispose();
    process.exit(0);
  });
