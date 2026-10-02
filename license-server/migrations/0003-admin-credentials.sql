CREATE TABLE IF NOT EXISTS admin_credentials (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    bootstrap_hash TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
