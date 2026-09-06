import { withDb } from './cache';

export interface TranslationIdentity {
  owner: string;
  account: string;
  thread: string;
  message: string;
  sourceHash: string;
}
export interface CachedTranslation {
  html: string;
  subject: string;
  language: string;
  expiresAt: number;
}

export async function translationSourceHash(subject: string, html: string) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([subject, html])),
  );
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
}

export async function getTranslation(
  key: TranslationIdentity,
  language?: string,
): Promise<CachedTranslation | null> {
  return withDb(async (sql) => {
    await sql`DELETE FROM mail0_mail_translations t WHERE t.user_id=${key.owner} AND t.created_at<=now()-coalesce((SELECT max_age_days FROM mail0_sync_settings WHERE user_id=${key.owner}),90)*interval '1 day'`;
    if (language) {
      await sql`UPDATE mail0_mail_translations SET last_used_at=now() WHERE user_id=${key.owner} AND account_id=${key.account} AND thread_id=${key.thread} AND message_id=${key.message} AND source_hash=${key.sourceHash} AND language=${language}`;
    }
    const [row] =
      await sql`SELECT html,subject,language,created_at+coalesce((SELECT max_age_days FROM mail0_sync_settings WHERE user_id=${key.owner}),90)*interval '1 day' AS expires_at FROM mail0_mail_translations WHERE user_id=${key.owner} AND account_id=${key.account} AND thread_id=${key.thread} AND message_id=${key.message} AND source_hash=${key.sourceHash} AND (${language ?? null}::text IS NULL OR language=${language ?? null}) ORDER BY last_used_at DESC,created_at DESC,language LIMIT 1`;
    return row
      ? {
          html: row.html as string,
          subject: row.subject as string,
          language: row.language as string,
          expiresAt: new Date(row.expires_at).getTime(),
        }
      : null;
  });
}

export async function saveTranslation(
  key: TranslationIdentity,
  language: string,
  value: { html: string; subject: string },
) {
  await withDb(
    (sql) =>
      sql`INSERT INTO mail0_mail_translations(user_id,account_id,thread_id,message_id,language,source_hash,html,subject) VALUES(${key.owner},${key.account},${key.thread},${key.message},${language},${key.sourceHash},${value.html},${value.subject}) ON CONFLICT(user_id,account_id,thread_id,message_id,language) DO UPDATE SET source_hash=excluded.source_hash,html=excluded.html,subject=excluded.subject,created_at=now(),last_used_at=now()`,
  );
  return getTranslation(key, language);
}
