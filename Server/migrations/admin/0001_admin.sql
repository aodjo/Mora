PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL
);

CREATE TABLE webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NULL
);

CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('registration', 'authentication')),
  user_id TEXT NULL REFERENCES users(id),
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE recovery_codes (
  user_id TEXT NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL,
  used_at INTEGER NULL,
  PRIMARY KEY (user_id, code_hash)
);

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  permissions TEXT NOT NULL,
  system INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1)),
  created_at INTEGER NOT NULL
);

CREATE TABLE user_roles (
  user_id TEXT NOT NULL REFERENCES users(id),
  role_id TEXT NOT NULL REFERENCES roles(id),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE service_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  expires_at INTEGER NULL,
  revoked_at INTEGER NULL,
  last_used_at INTEGER NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE recordings (
  id TEXT PRIMARY KEY,
  isrc TEXT NULL UNIQUE,
  mbid TEXT NULL,
  artist TEXT NOT NULL,
  title TEXT NOT NULL,
  album TEXT NULL,
  duration_ms INTEGER NOT NULL,
  language TEXT NOT NULL DEFAULT 'und',
  identification_state TEXT NOT NULL DEFAULT 'pending' CHECK (identification_state IN ('pending', 'verified', 'ambiguous')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE media_sources (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES recordings(id),
  url TEXT NOT NULL,
  video_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  official INTEGER NOT NULL DEFAULT 0 CHECK (official IN (0, 1)),
  source_type TEXT NOT NULL CHECK (source_type IN ('song', 'topic', 'unofficial')),
  score REAL NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE (recording_id, video_id)
);

CREATE TABLE input_revisions (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES recordings(id),
  source_id TEXT NULL REFERENCES media_sources(id),
  parent_id TEXT NULL REFERENCES input_revisions(id),
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'ready', 'superseded')),
  pipeline_profile TEXT NOT NULL,
  created_by TEXT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE lyric_revisions (
  id TEXT PRIMARY KEY,
  input_revision_id TEXT NOT NULL REFERENCES input_revisions(id),
  provider TEXT NOT NULL,
  provider_ref TEXT NULL,
  layer TEXT NOT NULL CHECK (layer IN ('raw', 'original', 'translation', 'romanization')),
  language TEXT NOT NULL,
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  preprocessor TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1,
  review_required INTEGER NOT NULL DEFAULT 0 CHECK (review_required IN (0, 1)),
  offset_map TEXT NOT NULL DEFAULT '[]',
  rules TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  UNIQUE (input_revision_id, provider, layer, text_hash)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  input_revision_id TEXT NOT NULL REFERENCES input_revisions(id),
  state TEXT NOT NULL,
  priority REAL NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  worker_id TEXT NULL,
  current_stage TEXT NULL,
  progress REAL NOT NULL DEFAULT 0,
  error_code TEXT NULL,
  available_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (input_revision_id)
);

CREATE TABLE job_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  worker_id TEXT NULL,
  state TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NULL,
  error_code TEXT NULL,
  metrics TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE stage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  attempt_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  state TEXT NOT NULL,
  progress REAL NULL,
  code TEXT NULL,
  metrics TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE workers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  backend TEXT NOT NULL,
  hardware TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  self_test TEXT NOT NULL,
  production_ready INTEGER NOT NULL CHECK (production_ready IN (0, 1)),
  desired_state TEXT NOT NULL DEFAULT 'active' CHECK (desired_state IN ('active', 'draining', 'paused', 'update')),
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE enrollment_tokens (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used_at INTEGER NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE alignment_candidates (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  input_revision_id TEXT NOT NULL REFERENCES input_revisions(id),
  variant_id TEXT NOT NULL REFERENCES lyric_revisions(id),
  parent_id TEXT NULL REFERENCES alignment_candidates(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'published', 'withdrawn')),
  tokenizer TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  fp_lens BLOB NOT NULL,
  fp_types BLOB NOT NULL,
  line_spans BLOB NOT NULL,
  word_spans BLOB NOT NULL,
  speaker_turns BLOB NOT NULL,
  word_speakers BLOB NOT NULL,
  line_speakers BLOB NOT NULL,
  quality TEXT NOT NULL,
  quality_score REAL NOT NULL,
  pipeline_version TEXT NOT NULL,
  backend TEXT NOT NULL,
  hardware TEXT NOT NULL,
  created_by TEXT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL REFERENCES recordings(id),
  candidate_id TEXT NOT NULL REFERENCES alignment_candidates(id),
  public_alignment_id INTEGER NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'superseded', 'withdrawn')),
  policy_version TEXT NOT NULL,
  created_by TEXT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL,
  speaker_id INTEGER NULL,
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  encryption TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  chunk_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER NULL
);

CREATE TABLE edit_leases (
  candidate_id TEXT PRIMARY KEY REFERENCES alignment_candidates(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE draft_edits (
  candidate_id TEXT NOT NULL REFERENCES alignment_candidates(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  data TEXT NOT NULL,
  valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (candidate_id, user_id)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  secret INTEGER NOT NULL DEFAULT 0 CHECK (secret IN (0, 1)),
  updated_by TEXT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE notification_targets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('webhook', 'discord')),
  name TEXT NOT NULL,
  url_ciphertext TEXT NOT NULL,
  events TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL,
  actor_id TEXT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NULL,
  summary TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX jobs_state_priority_idx ON jobs(state, priority DESC, available_at);
CREATE INDEX stage_events_job_idx ON stage_events(job_id, id);
CREATE INDEX candidates_status_idx ON alignment_candidates(status, created_at);
CREATE INDEX audit_created_idx ON audit_log(created_at DESC);
CREATE INDEX lyrics_input_idx ON lyric_revisions(input_revision_id);
