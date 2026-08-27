-- 정렬이 실제로 몇 ms 틀리는지를 대시보드가 들고 있게 한다.
--
-- 그동안 이 숫자는 내 터미널에만 있었다. 파이프라인을 고칠 때마다 "좋아졌나"를 물어야 하는데,
-- 답이 사람의 스크롤백에 있으면 다음 사람은 물을 수 없다. 앵커 밀도와 숨 자리는 후보마다
-- 붙어 있지만 그것들은 대리 지표이고, 진짜 오차는 정답셋을 돌려야만 나온다.
--
-- 한 번 돌린 것이 run 하나, 그 안의 곡마다 한 줄이다. 판을 지우지 않고 쌓아 두는 것은
-- 견주기 위해서다 — 오늘 146 ms 였다가 내일 400 ms 가 되면 그 사이에 무엇을 했는지 물어야 한다.

CREATE TABLE eval_runs (
  id TEXT PRIMARY KEY,
  -- 어느 판의 파이프라인이었나. 커밋을 적어 두지 않으면 견줄 수가 없다.
  pipeline_version TEXT NOT NULL,
  -- 정답을 어디서 가져왔나. 지금은 lrclib 뿐이지만 손으로 맞춘 것이 생기면 갈린다.
  truth_source TEXT NOT NULL,
  songs INTEGER NOT NULL,
  -- 곡별 오차 가운뎃값들의 가운뎃값. 한 곡이 크게 틀려도 전체가 흔들리지 않는다.
  median_error_ms INTEGER NOT NULL,
  -- 사람이 실제로 느끼는 것. 0.3 초 안에 든 줄의 비율을 곡마다 내어 평균한 값이다.
  within_300_share REAL NOT NULL,
  note TEXT NULL,
  created_by TEXT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE eval_songs (
  run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  artist TEXT NOT NULL,
  title TEXT NOT NULL,
  language TEXT NOT NULL,
  lines INTEGER NOT NULL,
  -- 곡 전체가 일정하게 밀린 양. 유튜브 음원과 공식 음원의 인트로 차이라 정렬의 잘못이
  -- 아니다. 아래 오차는 이만큼을 빼고 잰 값이고, 이 값 자체가 크면 다른 음원을 받은 것이다.
  shift_ms INTEGER NOT NULL,
  median_error_ms INTEGER NOT NULL,
  p90_error_ms INTEGER NOT NULL,
  within_300_share REAL NOT NULL,
  anchor_density REAL NOT NULL,
  breath_gaps REAL NOT NULL,
  PRIMARY KEY (run_id, video_id)
);

CREATE INDEX eval_runs_time_idx ON eval_runs(created_at DESC);
CREATE INDEX eval_songs_error_idx ON eval_songs(run_id, median_error_ms DESC);
