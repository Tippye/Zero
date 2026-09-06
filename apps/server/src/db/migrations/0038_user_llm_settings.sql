CREATE TABLE IF NOT EXISTS "mail0_user_llm_settings" (
  "user_id" text PRIMARY KEY REFERENCES "mail0_user"("id") ON DELETE CASCADE,
  "profiles" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "active_id" text
);
