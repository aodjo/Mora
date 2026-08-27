-- 곡마다 나온 숫자가 맞는지 사람이 보고 판단할 수 있게, 줄마다의 견줌을 남긴다.
--
-- "오차 가운뎃값 146ms" 는 그것만으로는 믿을 근거가 없다. 어느 줄을 어디에 놓았고 정답은
-- 어디였는지가 나란히 보여야 "맞구나" 라고 할 수 있다. 지금은 그 판단을 하려면 인스턴스에
-- 들어가 로그를 뒤져야 하는데, 그건 이 화면을 보는 사람이 할 수 있는 일이 아니다.
--
-- 곡당 마흔 줄쯤이라 마흔 곡이면 천육백 줄이다. 판을 쌓아도 감당할 크기다.

CREATE TABLE eval_lines (
  run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  line_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  -- 우리가 놓은 자리와 정답. 곡 전체의 치우침은 빼지 않은 날값이다 — 화면에서 빼서 보여준다.
  ours_ms INTEGER NOT NULL,
  truth_ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, video_id, line_index)
);

CREATE INDEX eval_lines_song_idx ON eval_lines(run_id, video_id, line_index);
