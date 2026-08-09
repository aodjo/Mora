-- 담긴 것과 넘긴 것을 구분한다.
--
-- 장바구니에 담자마자 상태가 'held' 였고 Collector 도 'held' 를 집어갔다. 그래서 담는 즉시
-- 수집이 시작됐고, 처리 버튼은 누를 것이 남지 않은 뒤에 눌리는 버튼이었다. 잘못 담은 곡을
-- 내려받기 전에 뺄 수 있어야 장바구니이므로, 넘겨진 상태를 따로 둔다.
PRAGMA foreign_keys = OFF;

CREATE TABLE song_basket_next (
  id TEXT PRIMARY KEY,
  artist TEXT NOT NULL,
  title TEXT NOT NULL,
  album TEXT NULL,
  duration_ms INTEGER NULL,
  isrc TEXT NULL,
  artwork TEXT NULL,
  providers TEXT NOT NULL DEFAULT '[]',
  -- held: 담아만 둔 것. released: 처리를 눌러 Collector 에게 넘긴 것.
  state TEXT NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'released', 'claimed', 'done', 'failed')),
  claimed_by TEXT NULL,
  claimed_at INTEGER NULL,
  error TEXT NULL,
  added_by TEXT NULL,
  added_at INTEGER NOT NULL
);

INSERT INTO song_basket_next SELECT * FROM song_basket;
DROP TABLE song_basket;
ALTER TABLE song_basket_next RENAME TO song_basket;

CREATE UNIQUE INDEX song_basket_song_idx ON song_basket(artist, title);
CREATE INDEX song_basket_state_idx ON song_basket(state, added_at);

PRAGMA foreign_keys = ON;
