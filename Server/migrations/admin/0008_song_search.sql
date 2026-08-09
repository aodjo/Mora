-- 검색 큐가 두 가지 일을 맡는다: 음원(YouTube) 검색과 곡(스트리밍 서비스) 검색.
-- 기존 행은 전부 음원 검색이므로 그 값을 기본으로 둔다.
ALTER TABLE search_requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'youtube';
-- 곡 검색에서 어떤 서비스를 물을지. NULL이면 collector가 아는 전부.
ALTER TABLE search_requests ADD COLUMN providers TEXT NULL;

-- 콘솔이 담아둔 곡. 처리 버튼을 누르기 전까지 여기 머문다.
CREATE TABLE song_basket (
  id TEXT PRIMARY KEY,
  artist TEXT NOT NULL,
  title TEXT NOT NULL,
  album TEXT NULL,
  duration_ms INTEGER NULL,
  isrc TEXT NULL,
  artwork TEXT NULL,
  -- 어느 서비스들이 이 곡을 갖고 있었는지. 아이콘으로 보여준다.
  providers TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'claimed', 'done', 'failed')),
  claimed_by TEXT NULL,
  claimed_at INTEGER NULL,
  error TEXT NULL,
  added_by TEXT NULL,
  added_at INTEGER NOT NULL
);

-- 같은 곡을 두 번 담지 않는다.
CREATE UNIQUE INDEX song_basket_song_idx ON song_basket(artist, title);
CREATE INDEX song_basket_state_idx ON song_basket(state, added_at);
