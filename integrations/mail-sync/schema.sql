CREATE TABLE IF NOT EXISTS mail0_sync_settings (
 user_id text PRIMARY KEY REFERENCES mail0_user(id) ON DELETE CASCADE,
 max_messages integer NOT NULL DEFAULT 500 CHECK(max_messages BETWEEN 50 AND 5000),
 max_age_days integer NOT NULL DEFAULT 90 CHECK(max_age_days BETWEEN 7 AND 3650),
 body_budget_mb integer NOT NULL DEFAULT 50 CHECK(body_budget_mb BETWEEN 5 AND 1024),
 interval_seconds integer NOT NULL DEFAULT 120 CHECK(interval_seconds BETWEEN 60 AND 3600)
);
CREATE TABLE IF NOT EXISTS mail0_sync_accounts (
 user_id text NOT NULL REFERENCES mail0_user(id) ON DELETE CASCADE,
 account_id text NOT NULL, provider text NOT NULL,
 email text NOT NULL, name text NOT NULL,
 status text NOT NULL DEFAULT 'pending', error_code text,
 last_synced_at timestamptz, next_sync_at timestamptz NOT NULL DEFAULT now(),
 requested_at timestamptz NOT NULL DEFAULT now(), completed_request_at timestamptz,
 checkpoint text, last_full_sync_at timestamptz,
 PRIMARY KEY(user_id,account_id)
);
CREATE TABLE IF NOT EXISTS mail0_cached_mail (
 user_id text NOT NULL, account_id text NOT NULL, native_id text NOT NULL,
 kind text NOT NULL DEFAULT 'mail', folders text[] NOT NULL, tags text[] NOT NULL,
 received_at timestamptz NOT NULL, search_text text NOT NULL,
 preview jsonb, draft_preview jsonb, version text NOT NULL,
 body jsonb, body_bytes integer NOT NULL DEFAULT 0, body_accessed_at timestamptz,
 PRIMARY KEY(user_id,account_id,kind,native_id),
 FOREIGN KEY(user_id,account_id) REFERENCES mail0_sync_accounts(user_id,account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS mail0_cached_mail_order_idx ON mail0_cached_mail(user_id, received_at DESC, account_id, native_id);
CREATE INDEX IF NOT EXISTS mail0_cached_mail_account_idx ON mail0_cached_mail(user_id, account_id, received_at DESC);
CREATE TABLE IF NOT EXISTS mail0_sync_worker_health (id integer PRIMARY KEY CHECK(id=1), heartbeat_at timestamptz NOT NULL);
-- Local AI categories are separate from provider labels and survive normal mailbox refreshes.
ALTER TABLE mail0_cached_mail ADD COLUMN IF NOT EXISTS ai_category text CHECK(ai_category IN ('primary','transactions','updates','promotions'));
ALTER TABLE mail0_cached_mail ADD COLUMN IF NOT EXISTS ai_source_hash text;
ALTER TABLE mail0_cached_mail ADD COLUMN IF NOT EXISTS ai_classified_at timestamptz;
ALTER TABLE mail0_sync_accounts ADD COLUMN IF NOT EXISTS classification_error text;
ALTER TABLE mail0_sync_accounts ADD COLUMN IF NOT EXISTS classification_retry_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE mail0_sync_accounts ADD COLUMN IF NOT EXISTS classification_updated_at timestamptz;
ALTER TABLE mail0_sync_accounts ADD COLUMN IF NOT EXISTS classification_paused boolean NOT NULL DEFAULT false;
ALTER TABLE mail0_sync_accounts ADD COLUMN IF NOT EXISTS classification_generation integer NOT NULL DEFAULT 0;
ALTER TABLE mail0_sync_accounts ADD COLUMN IF NOT EXISTS classification_running_at timestamptz;
ALTER TABLE mail0_sync_accounts ADD COLUMN IF NOT EXISTS classification_batch_size integer NOT NULL DEFAULT 10;
ALTER TABLE mail0_sync_accounts ADD COLUMN IF NOT EXISTS folder_errors jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Keep explicit choices independently of the bounded message/body cache.
CREATE TABLE IF NOT EXISTS mail0_category_feedback (
 user_id text NOT NULL, account_id text NOT NULL, native_id text NOT NULL,
 category text NOT NULL CHECK(category IN ('primary','transactions','updates','promotions')),
 sender text NOT NULL, subject text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,account_id,native_id),
 FOREIGN KEY(user_id,account_id) REFERENCES mail0_sync_accounts(user_id,account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS mail0_category_feedback_recent_idx ON mail0_category_feedback(user_id,account_id,updated_at DESC);

CREATE TABLE IF NOT EXISTS mail0_mail_translations (
 user_id text NOT NULL REFERENCES mail0_user(id) ON DELETE CASCADE,
 account_id text NOT NULL, thread_id text NOT NULL, message_id text NOT NULL,
 language text NOT NULL, source_hash text NOT NULL,
 html text NOT NULL, subject text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,account_id,thread_id,message_id,language)
);
CREATE INDEX IF NOT EXISTS mail0_mail_translations_expiry_idx ON mail0_mail_translations(user_id,created_at);

-- Choosing a cached language must not extend its original retention period.
ALTER TABLE mail0_mail_translations ADD COLUMN IF NOT EXISTS last_used_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS mail0_classifier_health (id integer PRIMARY KEY CHECK(id=1), heartbeat_at timestamptz NOT NULL);

CREATE TABLE IF NOT EXISTS mail0_classification_settings (
 user_id text PRIMARY KEY REFERENCES mail0_user(id) ON DELETE CASCADE,
 concurrency integer NOT NULL CHECK(concurrency BETWEEN 1 AND 4),
 batch_size integer NOT NULL CHECK(batch_size BETWEEN 1 AND 50),
 interval_seconds integer NOT NULL CHECK(interval_seconds BETWEEN 2 AND 3600),
 timeout_seconds integer NOT NULL CHECK(timeout_seconds BETWEEN 5 AND 120),
 recent_days integer NOT NULL CHECK(recent_days BETWEEN 1 AND 365),
 history_every_batches integer NOT NULL CHECK(history_every_batches BETWEEN 1 AND 100)
);
-- This column is only the adaptive error backoff cap; configured batch size is separate.
ALTER TABLE mail0_sync_accounts ALTER COLUMN classification_batch_size SET DEFAULT 50;
