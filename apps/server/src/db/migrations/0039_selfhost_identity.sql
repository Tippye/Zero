ALTER TABLE "mail0_user" ADD COLUMN IF NOT EXISTS "is_anonymous" boolean NOT NULL DEFAULT false;
