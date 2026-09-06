import { createDb } from '../db';
import { userLlmSettings, connection } from '../db/schema';
import { eq } from 'drizzle-orm';
import { env } from '../env';
import { TRPCError } from '@trpc/server';
import { getContext } from 'hono/context-storage';
import type { HonoContext } from '../ctx';
import { isLocalLlmHost } from './llm-http';

export type LlmProfile = { id: string; name: string; baseUrl: string; model: string; miniModel: string; embeddingModel: string; encryptedKey: string };
export type LlmState = { profiles: LlmProfile[]; activeId: string | null };
export type LlmIdentity = { ownerId?: string; connectionId?: string };
export const missingLlm = () => new TRPCError({ code: 'PRECONDITION_FAILED', message: 'LLM_NOT_CONFIGURED: /settings/llm' });

export function normalizeLlmUrl(value: string) {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new TRPCError({ code: 'BAD_REQUEST', message: 'LLM_INVALID_URL' }); }
  const local = isLocalLlmHost(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(env.SELF_HOSTED === 'true' && local && url.protocol === 'http:')) ||
      ['169.254.169.254', 'metadata.google.internal', '0.0.0.0', '[::]'].includes(url.hostname)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'LLM_INVALID_URL' });
  }
  return url.href.replace(/\/+$/, '');
}

async function cipherKey() {
  if (!env.BETTER_AUTH_SECRET) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'LLM_KEY_UNAVAILABLE' });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`zero-llm-v1:${env.BETTER_AUTH_SECRET}`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function sealKey(value: string, ownerId: string, id: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`${ownerId}:${id}`) }, await cipherKey(), new TextEncoder().encode(value));
  return `${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...new Uint8Array(encrypted)))}`;
}
export async function revealKey(profile: LlmProfile, ownerId: string) {
  try {
    const [iv, data] = profile.encryptedKey.split('.').map(value => Uint8Array.from(atob(value), c => c.charCodeAt(0)));
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`${ownerId}:${profile.id}`) }, await cipherKey(), data);
    return new TextDecoder().decode(decrypted);
  } catch { throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'LLM_KEY_UNAVAILABLE' }); }
}
export function environmentProfile() {
  if (!env.OPENAI_API_KEY?.trim()) return null;
  return { id: 'environment', name: '.env', baseUrl: (env.OPENAI_BASE_URL || env.OPENAI_URL || env.OPEN_URL || 'https://api.openai.com/v1').trim().replace(/\/+$/, ''),
    model: env.OPENAI_MODEL || 'gpt-4o', miniModel: env.OPENAI_MINI_MODEL || env.OPENAI_MODEL || 'gpt-4o-mini', embeddingModel: env.OPENAI_EMBEDDING_MODEL || '', hasKey: true, source: 'environment' as const };
}
export async function readLlmState(ownerId: string): Promise<LlmState> {
  const { db, conn } = createDb(env.HYPERDRIVE.connectionString);
  try {
    const [row] = await db.select().from(userLlmSettings).where(eq(userLlmSettings.userId, ownerId));
    return row || { profiles: [], activeId: environmentProfile() ? 'environment' : null };
  } finally { await conn.end(); }
}
export async function changeLlmState(ownerId: string, update: (state: LlmState) => Promise<LlmState> | LlmState) {
  const { db, conn } = createDb(env.HYPERDRIVE.connectionString);
  try {
    await db.transaction(async tx => {
      await tx.insert(userLlmSettings).values({ userId: ownerId, profiles: [], activeId: environmentProfile() ? 'environment' : null }).onConflictDoNothing();
      const [row] = await tx.select().from(userLlmSettings).where(eq(userLlmSettings.userId, ownerId)).for('update');
      const state = await update(row);
      await tx.update(userLlmSettings).set({ profiles: state.profiles, activeId: state.activeId }).where(eq(userLlmSettings.userId, ownerId));
    });
  } finally { await conn.end(); }
}
export async function llmOverview(ownerId: string) {
  const state = await readLlmState(ownerId), configured = environmentProfile();
  const profiles = state.profiles.map(({ encryptedKey, ...profile }) => ({ ...profile, hasKey: !!encryptedKey, source: 'settings' as const }));
  const all = [...profiles, ...(configured ? [configured] : [])];
  return { profiles: all, activeId: state.activeId, ready: all.some(profile => profile.id === state.activeId && profile.hasKey && !!profile.model) };
}
export function requestLlmIdentity(): LlmIdentity {
  try { return { ownerId: getContext<HonoContext>().var.sessionUser?.id }; } catch { return {}; }
}
export async function resolveLlm(identity: LlmIdentity = requestLlmIdentity()) {
  let ownerId = identity.ownerId;
  if (!ownerId && identity.connectionId) {
    const { db, conn } = createDb(env.HYPERDRIVE.connectionString);
    try { ownerId = (await db.select({ userId: connection.userId }).from(connection).where(eq(connection.id, identity.connectionId)))[0]?.userId; }
    finally { await conn.end(); }
    if (!ownerId) throw missingLlm();
  }
  const state = ownerId ? await readLlmState(ownerId) : { profiles: [], activeId: 'environment' };
  if (state.activeId === 'environment') {
    const profile = environmentProfile();
    if (profile) return { ...profile, apiKey: env.OPENAI_API_KEY };
  }
  const profile = state.profiles.find(p => p.id === state.activeId);
  if (!profile || !ownerId) throw missingLlm();
  return { ...profile, apiKey: await revealKey(profile, ownerId) };
}
