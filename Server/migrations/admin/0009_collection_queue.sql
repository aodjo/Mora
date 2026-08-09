-- 수집할 곡의 공용 대기열.
-- 전에는 Collector마다 자기 예산만큼 차트를 훑었으므로, 세 대를 띄우면 같은 일을 세 번 했다.
-- 이제 어드민이 "전체로 몇 곡"을 정하고, Collector들은 이 대기열에서 한 곡씩 집어간다.
CREATE TABLE collection_queue (
  id TEXT PRIMARY KEY,
  artist TEXT NOT NULL,
  title TEXT NOT NULL,
  market TEXT NOT NULL DEFAULT 'KR',
  -- 차트 순위에서 온 우선순위. 높을수록 먼저 나간다.
  priority REAL NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'done', 'failed')),
  claimed_by TEXT NULL,
  claimed_at INTEGER NULL,
  error TEXT NULL,
  -- 어느 채우기 회차에서 들어왔는지. 목표를 다시 세면 이전 회차는 정리된다.
  filled_at INTEGER NOT NULL
);

-- 같은 곡이 두 번 줄 서지 않는다.
CREATE UNIQUE INDEX collection_queue_song_idx ON collection_queue(artist, title);
CREATE INDEX collection_queue_next_idx ON collection_queue(state, priority DESC);

-- 차트를 훑는 일은 한 대만 하면 된다. 이 자리를 잡은 Collector가 대기열을 채운다.
CREATE TABLE collection_lease (
  id TEXT PRIMARY KEY CHECK (id = 'discovery'),
  holder TEXT NOT NULL,
  taken_at INTEGER NOT NULL
);

-- 채울 것이 없을 때 차트를 계속 다시 훑지 않도록, 지난 채우기의 결과를 기억한다.
ALTER TABLE collection_lease ADD COLUMN finished_at INTEGER NULL;
ALTER TABLE collection_lease ADD COLUMN added INTEGER NOT NULL DEFAULT 0;
