CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  key_suffix TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  max_devices INTEGER NOT NULL DEFAULT 1 CHECK(max_devices BETWEEN 1 AND 50),
  expires_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  features_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activations (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  device_hash TEXT NOT NULL,
  device_label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  activated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(license_id, device_hash)
);

CREATE INDEX IF NOT EXISTS idx_activations_license_active
  ON activations(license_id, revoked_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  license_id TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
