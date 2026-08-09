-- 콘솔이 음원을 직접 찾을 때 쓰는 검색 큐.
-- Worker는 yt-dlp를 돌릴 수 없고 Collector는 여러 대가 떠 있으므로, 요청을 여기 두고
-- 먼저 집는 Collector가 처리한다. 관리자 입장에서 어느 대가 처리했는지는 상관없다.
CREATE TABLE search_requests (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'done', 'failed')),
  claimed_by TEXT NULL,
  claimed_at INTEGER NULL,
  result TEXT NULL,
  error TEXT NULL,
  created_by TEXT NULL,
  created_at INTEGER NOT NULL
);

-- 대기 중인 가장 오래된 요청을 집는 것이 유일한 조회 패턴이다.
CREATE INDEX search_request_queue_idx ON search_requests(state, created_at);
