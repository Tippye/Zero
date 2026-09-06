CREATE TABLE IF NOT EXISTS mail0_notification_events (
 id bigserial PRIMARY KEY,
 user_id text NOT NULL REFERENCES mail0_user(id) ON DELETE CASCADE,
 account_id text NOT NULL,
 native_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mail0_notification_message_idx ON mail0_notification_events(user_id,account_id,native_id);
CREATE INDEX IF NOT EXISTS mail0_notification_owner_idx ON mail0_notification_events(user_id,id);
CREATE OR REPLACE FUNCTION mail0_new_mail_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Initial historical imports and later cache refills do not notify as new mail.
 IF NEW.kind='mail' AND 'inbox'=ANY(NEW.folders) AND 'UNREAD'=ANY(NEW.tags)
 AND NEW.received_at > now()-interval '10 minutes'
 AND EXISTS(SELECT 1 FROM mail0_sync_accounts WHERE user_id=NEW.user_id AND account_id=NEW.account_id AND last_synced_at IS NOT NULL)
 THEN
   INSERT INTO mail0_notification_events(user_id,account_id,native_id) VALUES(NEW.user_id,NEW.account_id,NEW.native_id) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mail0_new_mail_notification ON mail0_cached_mail;
CREATE TRIGGER mail0_new_mail_notification AFTER INSERT ON mail0_cached_mail FOR EACH ROW EXECUTE FUNCTION mail0_new_mail_event();
