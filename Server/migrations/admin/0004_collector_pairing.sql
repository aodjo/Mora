CREATE TABLE collector_pairings (
  id TEXT PRIMARY KEY,
  pin_hash TEXT NOT NULL UNIQUE,
  device_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
  credential_ciphertext TEXT NULL,
  expires_at INTEGER NOT NULL,
  approved_by TEXT NULL REFERENCES users(id),
  approved_at INTEGER NULL,
  consumed_at INTEGER NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX collector_pairings_expiry_idx ON collector_pairings(status, expires_at);
