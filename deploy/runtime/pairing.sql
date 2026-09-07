CREATE TABLE IF NOT EXISTS mail0_pairing_owner (
  id integer PRIMARY KEY CHECK (id = 1),
  user_id text NOT NULL REFERENCES mail0_user(id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS mail0_pairing_request (
  id text PRIMARY KEY,
  code_hash text NOT NULL UNIQUE,
  secret_hash text NOT NULL UNIQUE,
  origin text NOT NULL,
  device_name text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('cookie', 'native')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  user_id text REFERENCES mail0_user(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '5 minutes',
  last_poll_at timestamptz
);
CREATE INDEX IF NOT EXISTS mail0_pairing_expiry_idx ON mail0_pairing_request(expires_at);
CREATE TABLE IF NOT EXISTS mail0_pairing_device (
  session_id text PRIMARY KEY REFERENCES mail0_session(id) ON DELETE CASCADE,
  name text NOT NULL
);
CREATE TABLE IF NOT EXISTS mail0_pairing_rate (
  key text PRIMARY KEY,
  count integer NOT NULL,
  expires_at timestamptz NOT NULL
);
