CREATE TABLE generator_pairings (
  id TEXT PRIMARY KEY,
  pin_hash TEXT NOT NULL UNIQUE,
  device_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
  credential_ciphertext TEXT NULL,
  expires_at INTEGER NOT NULL,
  approved_by TEXT NULL REFERENCES users(id),
  approved_at INTEGER NULL,
  consumed_at INTEGER NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX generator_pairings_expiry_idx ON generator_pairings(status, expires_at);
