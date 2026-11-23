CREATE TABLE IF NOT EXISTS app_state (
  state_key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS app_state_updated_at_idx ON app_state (updated_at DESC);

CREATE TABLE IF NOT EXISTS pqtv_sessions (
  sid VARCHAR NOT NULL COLLATE "default",
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL,
  CONSTRAINT pqtv_sessions_pkey PRIMARY KEY (sid)
);
CREATE INDEX IF NOT EXISTS pqtv_sessions_expire_idx ON pqtv_sessions (expire);
