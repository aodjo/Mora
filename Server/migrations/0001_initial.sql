PRAGMA foreign_keys = ON;

CREATE TABLE recording (
  isrc TEXT PRIMARY KEY,
  mbid TEXT NULL UNIQUE,
  duration_ms INTEGER NULL CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

CREATE TABLE alignment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  isrc TEXT NOT NULL REFERENCES recording(isrc),
  text_hash TEXT NOT NULL CHECK (length(text_hash) = 16),
  tokenizer TEXT NOT NULL,
  fp_lens BLOB NOT NULL,
  fp_types BLOB NOT NULL,
  line_spans BLOB NOT NULL,
  word_spans BLOB NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual', 'forced-align')),
  contributor TEXT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (isrc, text_hash, tokenizer)
);

CREATE INDEX alignment_isrc_idx ON alignment(isrc);
CREATE INDEX alignment_hash_idx ON alignment(isrc, text_hash, tokenizer);
