-- 가사의 글자와, 그 글자를 누가 줬는지를 나눈다.
--
-- lyric_revisions 의 유니크 제약에 provider 가 들어 있어서, 글자가 완전히 같아도 제공자가
-- 다르면 다른 행이 됐다. 국내 서비스들은 같은 가사를 나눠 쓰므로 한 곡에 같은 글자가 네댓 벌씩
-- 쌓였고, Generator 는 그걸 각각 정렬했다 — 실측으로 정렬 대상의 32%가 이미 정렬한 글자였다.
--
-- 이제 글자는 lyric_texts 에 한 벌만 있고, 제공자는 그것을 가리키기만 한다. 정렬은 글자에
-- 붙으므로 한 번이면 되고, "멜론·벅스·지니가 같은 가사를 줬다"는 사실은 lyric_sources 에
-- 그대로 남는다.
PRAGMA foreign_keys = OFF;

CREATE TABLE lyric_texts (
  id TEXT PRIMARY KEY,
  input_revision_id TEXT NOT NULL REFERENCES input_revisions(id),
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
  -- 제공자는 여기 없다. 그것이 이 테이블의 요점이다.
  UNIQUE (input_revision_id, layer, text_hash)
);

CREATE TABLE lyric_sources (
  text_id TEXT NOT NULL REFERENCES lyric_texts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_ref TEXT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (text_id, provider)
);

-- 기존 행을 옮긴다. 같은 (회차, layer, 글자) 는 한 행으로 접히고, 제공자는 각자 남는다.
INSERT INTO lyric_texts (
  id, input_revision_id, layer, language, text, text_hash, preprocessor, confidence,
  review_required, offset_map, rules, created_at
)
SELECT MIN(id), input_revision_id, layer, MIN(language), MIN(text), text_hash, MIN(preprocessor),
       MIN(confidence), MAX(review_required), MIN(offset_map), MIN(rules), MIN(created_at)
FROM lyric_revisions
GROUP BY input_revision_id, layer, text_hash;

INSERT OR IGNORE INTO lyric_sources (text_id, provider, provider_ref, fetched_at)
SELECT t.id, l.provider, l.provider_ref, l.created_at
FROM lyric_revisions l
JOIN lyric_texts t
  ON t.input_revision_id = l.input_revision_id AND t.layer = l.layer AND t.text_hash = l.text_hash;

CREATE INDEX lyric_texts_revision_idx ON lyric_texts(input_revision_id, layer);
CREATE INDEX lyric_sources_provider_idx ON lyric_sources(provider);

DROP TABLE lyric_revisions;

PRAGMA foreign_keys = ON;

-- 후보가 가리키는 곳도 새 테이블로 옮긴다. SQLite 는 외래키만 따로 고칠 수 없어 표를 다시 만든다.
PRAGMA foreign_keys = OFF;

CREATE TABLE alignment_candidates_next (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  input_revision_id TEXT NOT NULL REFERENCES input_revisions(id),
  variant_id TEXT NOT NULL REFERENCES lyric_texts(id),
  parent_id TEXT NULL REFERENCES alignment_candidates_next(id),
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

INSERT INTO alignment_candidates_next SELECT * FROM alignment_candidates;
DROP TABLE alignment_candidates;
ALTER TABLE alignment_candidates_next RENAME TO alignment_candidates;

PRAGMA foreign_keys = ON;
