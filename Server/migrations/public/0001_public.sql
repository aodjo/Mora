PRAGMA foreign_keys = ON;

CREATE TABLE public_recording (
  isrc TEXT PRIMARY KEY,
  mbid TEXT NULL UNIQUE,
  artist_key TEXT NULL,
  title_key TEXT NULL,
  duration_ms INTEGER NULL CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

CREATE TABLE public_alignment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id TEXT NULL UNIQUE,
  isrc TEXT NOT NULL REFERENCES public_recording(isrc),
  text_hash TEXT NOT NULL CHECK (length(text_hash) = 16),
  tokenizer TEXT NOT NULL CHECK (tokenizer IN ('unilab-v1', 'unilab-v2')),
  fp_lens BLOB NOT NULL,
  fp_types BLOB NOT NULL,
  line_spans BLOB NOT NULL,
  word_spans BLOB NOT NULL,
  speaker_turns BLOB NOT NULL DEFAULT X'5B5D',
  word_speakers BLOB NOT NULL DEFAULT X'5B5D',
  line_speakers BLOB NOT NULL DEFAULT X'5B5D',
  quality_score REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL CHECK (source IN ('manual', 'forced-align')),
  contributor TEXT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL,
  UNIQUE (isrc, text_hash, tokenizer)
);

CREATE INDEX public_alignment_active_isrc_idx ON public_alignment(isrc, active);
CREATE INDEX public_alignment_hash_idx ON public_alignment(isrc, text_hash, tokenizer, active);
CREATE INDEX public_recording_metadata_idx ON public_recording(artist_key, title_key, duration_ms);
