CREATE TABLE IF NOT EXISTS license_sessions (
  session_hash TEXT PRIMARY KEY,
  activation_id TEXT NOT NULL REFERENCES activations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  released_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_license_sessions_active ON license_sessions(activation_id, released_at);
