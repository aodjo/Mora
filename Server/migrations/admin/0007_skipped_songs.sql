-- 수집을 건너뛴 곡. recordings 에는 남지 않으므로 여기 없으면 매 실행마다 다시 시도한다.
-- HOYO-MiX 게임 OST 한 곡을 건너뛰는 데 가사 제공자 다섯 곳을 매번 다시 묻고 있었다.
CREATE TABLE skipped_songs (
  song_key TEXT PRIMARY KEY,
  artist TEXT NOT NULL,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  -- 다시 시도해도 되는 시각. NULL이면 영영 다시 보지 않는다(연주곡은 가사가 생기지 않는다).
  retry_after INTEGER NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX skipped_song_retry_idx ON skipped_songs(retry_after);
