-- ISRC를 열쇠 자리에서 내린다.
--
-- 우리가 파는 것은 가사와 그 타이밍이고, 곡을 알아보는 길은 이미 세 갈래다: ISRC, MBID,
-- 그리고 아티스트·제목·길이. 그런데 ISRC가 기본키라서, 셋 중 나머지 둘로 충분히 찾을 수 있는
-- 곡도 코드가 없다는 이유만으로 공개할 자리가 없었다. 이제 공개 레코딩은 자기 id를 갖고,
-- ISRC는 있으면 좋은 식별자 중 하나가 된다.
PRAGMA foreign_keys = OFF;

CREATE TABLE public_recording_next (
  id TEXT PRIMARY KEY,
  isrc TEXT NULL UNIQUE,
  mbid TEXT NULL UNIQUE,
  artist_key TEXT NULL,
  title_key TEXT NULL,
  duration_ms INTEGER NULL CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

INSERT INTO public_recording_next (id, isrc, mbid, artist_key, title_key, duration_ms)
SELECT isrc, isrc, mbid, artist_key, title_key, duration_ms FROM public_recording;

CREATE TABLE public_alignment_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id TEXT NULL UNIQUE,
  recording_id TEXT NOT NULL REFERENCES public_recording_next(id) ON DELETE CASCADE,
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
  UNIQUE (recording_id, text_hash, tokenizer)
);

INSERT INTO public_alignment_next (
  revision_id, recording_id, text_hash, tokenizer, fp_lens, fp_types, line_spans, word_spans,
  speaker_turns, word_speakers, line_speakers, quality_score, source, contributor, active, created_at
)
SELECT revision_id, isrc, text_hash, tokenizer, fp_lens, fp_types, line_spans, word_spans,
       speaker_turns, word_speakers, line_speakers, quality_score, source, contributor, active, created_at
FROM public_alignment;

DROP TABLE public_alignment;
DROP TABLE public_recording;
ALTER TABLE public_recording_next RENAME TO public_recording;
ALTER TABLE public_alignment_next RENAME TO public_alignment;

CREATE INDEX public_alignment_active_idx ON public_alignment(recording_id, active);
CREATE INDEX public_alignment_hash_idx ON public_alignment(recording_id, text_hash, tokenizer, active);
CREATE INDEX public_recording_metadata_idx ON public_recording(artist_key, title_key, duration_ms);
CREATE INDEX public_recording_isrc_idx ON public_recording(isrc);

PRAGMA foreign_keys = ON;
