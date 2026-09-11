#!/usr/bin/env python3
"""**바이브에서 줄 시각이 붙은 가사를 긁어 모은다.** 서비스가 닫히면 다시 만들 수 없는 것이라, 곡을
고르기 전에 되도록 많이 받아 둔다.

지금 쌩 가사 길을 재는 자는 열두 곡 675 줄이 전부다. 곡 하나가 8% 를 좌우하니 어떤 규칙이 한 곡을
살리고 한 곡을 죽일 때 좋은지 나쁜지 가릴 수가 없고(이 세션에서 네 판을 그렇게 되돌렸다), 장르별로
성질을 재어 규칙에 넣는 일은 아예 못 한다. 목소리→가사 짝짓기 모델을 학습하려 해도 정답이 이것뿐이다.

**아티스트를 타고 번진다.** 검색으로 씨앗 아티스트를 얻고, 그 아티스트의 곡을 모두 가져오고, 그
곡에 이름을 올린 다른 아티스트를 줄에 세운다. 피처링과 합작이 다리가 되어 한 장르 안에 갇히지 않는다.
바이브가 주는 목록에는 `hasSyncLyric` 이 붙어 있어, 시각이 없는 곡은 가사를 받지도 않는다.

받은 것은 `vibe.db` 에 쌓인다. 다시 돌리면 이어서 받는다 — 아티스트는 끝난 것을 표시해 두고, 곡은
이미 받은 것을 건너뛴다. 소리(유튜브)는 여기서 받지 않는다. 소리는 나중에도 구할 수 있고 줄 시각은
아니기 때문이다.

@example
  python harvest.py 3000          # 줄 시각 있는 곡 3000 개를 채울 때까지
  python harvest.py 3000 --새로   # 씨앗 아티스트를 다시 검색해서 넣고 이어 받기
"""
import json
import os
import random
import sqlite3
import sys
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

#: 바이브 웹이 쓰는 API. 여는 열쇠는 없고 `Referer` 만 본다.
VIBE = "https://apis.naver.com/vibeWeb/musicapiweb"
BROWSER = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
           "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
#: 한 번에 부르는 수와 부름 사이의 쉼(초). 남의 서버다 — 셋이서 0.3 초씩 쉬면 초당 열 안쪽이고,
#: 그 속도로도 곡 이백 개를 스무 초에 받는다. 서두를 까닭이 없다.
HANDS = 3
REST = 0.3
#: 한 아티스트에서 가져올 곡의 최대(곡이 아주 많은 아티스트는 컴필레이션이 대부분이다).
ARTIST_MOST = 300
#: 곡으로 칠 길이(초)와 줄 수의 바닥. 인트로·효과음·나레이션을 거른다.
LEAST_SECONDS, MOST_SECONDS, LEAST_LINES = 60, 600, 8
#: 씨앗 아티스트를 찾을 검색어. 장르와 연대를 일부러 섞는다 — 번지기는 이 근처에서 시작한다.
SEEDS = [
    "아이유", "방탄소년단", "뉴진스", "아이브", "에스파", "세븐틴", "블랙핑크", "트와이스",
    "르세라핌", "(여자)아이들", "태연", "백예린", "잔나비", "혁오", "검정치마", "이무진",
    "폴킴", "박효신", "악동뮤지션", "십센치", "넬", "자우림", "국카스텐", "새소년",
    "다이나믹 듀오", "에픽하이", "지코", "빈지노", "창모", "pH-1", "박재범", "딘",
    "크러쉬", "자이언티", "헤이즈", "볼빨간사춘기", "멜로망스", "성시경", "김광석", "이문세",
    "신승훈", "임영웅", "장윤정", "소녀시대", "빅뱅", "2NE1", "god", "김건모",
    "선우정아", "이하이", "황가람", "데이식스", "QWER", "실리카겔", "터치드", "웨이브투어스",
]


def vibe_get(path: str, tries: int = 3) -> dict:
    """GET one Vibe endpoint, retrying rather than coming back empty-handed on one break.

    @param {str} path - Path under the Vibe API base.
    @param {int} [tries=3] - How many attempts to make.
    @returns {dict} The decoded response, or an empty dict when every attempt failed.
    """
    request = urllib.request.Request(
        VIBE + path,
        headers={"Referer": "https://vibe.naver.com/", "Accept": "application/json",
                 "User-Agent": BROWSER})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(request, timeout=15) as answer:
                got = json.loads(answer.read().decode("utf-8"))
            time.sleep(REST)
            return got
        except Exception as trouble:  # noqa: BLE001
            if attempt == tries - 1:
                print(f"  못 받음 {path}: {type(trouble).__name__}", file=sys.stderr, flush=True)
                return {}
            time.sleep(0.6 * (attempt + 1) + random.random() * 0.3)
    return {}


def result_of(got: dict) -> dict:
    """Dig the `result` out of Vibe's envelope.

    @param {dict} got - A decoded response.
    @returns {dict} The result object, empty when the shape is not what we expect.
    """
    inner = (got.get("response") or {}).get("result")
    return inner if isinstance(inner, dict) else {}


def seconds(raw: object) -> float:
    """Turn Vibe's `playTime`, written as `"04:03"`, into seconds.

    @param {object} raw - The duration as Vibe wrote it, or already a number.
    @returns {float} The duration in seconds, 0.0 when it cannot be read.
    """
    if isinstance(raw, (int, float)):
        return float(raw)
    out = 0.0
    try:
        for part in str(raw).split(":"):
            out = out * 60 + float(part)
    except ValueError:
        return 0.0
    return out


def open_db(where: str) -> sqlite3.Connection:
    """Open the harvest store, making it when it is not there yet.

    @param {str} where - Path to the SQLite file.
    @returns {sqlite3.Connection} A connection with the tables in place.
    """
    conn = sqlite3.connect(where, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("""CREATE TABLE IF NOT EXISTS artists (
        id INTEGER PRIMARY KEY, name TEXT, done INTEGER DEFAULT 0, found_at TEXT)""")
    #: 누가 누구를 데려왔는지. 번지기의 길 자체라, 나중에 그림을 다시 그리려면 이것이 있어야 한다.
    had = {one[1] for one in conn.execute("PRAGMA table_info(artists)")}
    for column, kind in (("from_id", "INTEGER"), ("by_track", "TEXT"), ("seed", "TEXT")):
        if column not in had:
            conn.execute(f"ALTER TABLE artists ADD COLUMN {column} {kind}")
    conn.execute("""CREATE TABLE IF NOT EXISTS tracks (
        track_id INTEGER PRIMARY KEY, title TEXT, artist TEXT, artist_ids TEXT,
        album TEXT, album_id INTEGER, duration REAL, has_sync INTEGER,
        state TEXT DEFAULT 'new', lines TEXT, line_count INTEGER, got_at TEXT)""")
    conn.execute("CREATE INDEX IF NOT EXISTS tracks_state ON tracks(state, has_sync)")
    conn.commit()
    return conn


def seed_words(more: list[str] | None = None) -> list[str]:
    """The words to search for seed artists: the file's if there is one, else the built-in list.

    `seeds.txt` sits next to this file, one word per line, `#` starting a comment. Adding a word
    and running again is the whole way to steer where the crawl goes next — the store remembers
    what it already walked, so only the new corner is new work.

    @param {list[str] | None} [more=None] - Extra words from the command line or the watcher.
    @returns {list[str]} Seed words, in file order, without repeats.
    """
    out: list[str] = []
    where = os.path.join(os.path.dirname(os.path.abspath(__file__)), "seeds.txt")
    if os.path.exists(where):
        with open(where, encoding="utf-8") as file:
            out = [one.split("#")[0].strip() for one in file]
    out = [one for one in out if one] or list(SEEDS)
    for one in more or []:
        if one and one not in out:
            out.append(one)
    return out


def seed_artists(conn: sqlite3.Connection, lock: threading.Lock, words: list[str] | None = None,
                 watch=None) -> int:
    """Search the seed words and put every artist they turn up into the queue.

    @param {sqlite3.Connection} conn - The harvest store.
    @param {threading.Lock} lock - Guards writes to the store.
    @param {list[str] | None} [words=None] - Which words to search; the seed list by default.
    @param {callable | None} [watch=None] - Called with each step, for a watcher to draw.
    @returns {int} How many artists were added.
    """
    added = 0
    asked = words if words is not None else seed_words()

    def one(word: str) -> tuple[str, list[tuple[int, str]]]:
        got = vibe_get(f"/v3/search/track?query={urllib.parse.quote(word)}&start=1&display=30&sort=RELEVANCE")
        rows = result_of(got).get("tracks") or []
        return word, [(int(a["artistId"]), a.get("artistName") or "")
                      for row in rows if isinstance(row, dict)
                      for a in (row.get("artists") or []) if isinstance(a, dict) and a.get("artistId")]

    with ThreadPoolExecutor(max_workers=HANDS) as pool:
        for word, found in pool.map(one, asked):
            fresh = []
            with lock:
                for artist_id, name in found:
                    new = conn.execute(
                        "INSERT OR IGNORE INTO artists (id, name, found_at, seed)"
                        " VALUES (?, ?, datetime('now'), ?)", (artist_id, name, word)).rowcount
                    added += new
                    if new:
                        fresh.append({"id": artist_id, "name": name})
                conn.commit()
            if watch:
                watch({"kind": "seed", "word": word, "artists": fresh})
    return added


def take_artist(conn: sqlite3.Connection, lock: threading.Lock, artist_id: int, name: str,
                watch=None) -> tuple[int, int]:
    """Read every track of one artist into the store, queueing the artists they bring with them.

    @param {sqlite3.Connection} conn - The harvest store.
    @param {threading.Lock} lock - Guards writes to the store.
    @param {int} artist_id - Whose tracks to read.
    @param {str} name - That artist's name, for the log.
    @param {callable | None} [watch=None] - Called with each step, for a watcher to draw.
    @returns {tuple[int, int]} New tracks, and new artists found along the way.
    """
    tracks, artists = [], {}
    start = 1
    if watch:
        watch({"kind": "walk", "id": artist_id, "name": name})
    while start <= ARTIST_MOST:
        got = result_of(vibe_get(f"/v2/artist/{artist_id}/tracks?start={start}&display=100"))
        rows = [one for one in (got.get("tracks") or []) if isinstance(one, dict)]
        if not rows:
            break
        for row in rows:
            singers = [one for one in (row.get("artists") or []) if isinstance(one, dict)]
            for one in singers:
                if one.get("artistId"):
                    artists[int(one["artistId"])] = one.get("artistName") or ""
            album = row.get("album") or {}
            tracks.append((
                int(row.get("trackId") or 0), row.get("trackTitle") or "",
                ", ".join(one.get("artistName") or "" for one in singers),
                json.dumps([one.get("artistId") for one in singers]),
                album.get("albumTitle") or "", album.get("albumId"),
                seconds(row.get("playTime")), 1 if row.get("hasSyncLyric") else 0))
        if len(rows) < 100 or start + 100 > int(got.get("trackTotalCount") or 0):
            break
        start += 100

    #: 어느 곡이 다리가 됐는지. 번지기의 실제 길이 그것이라, 장부에도 그림에도 함께 남긴다.
    bridges: dict[int, str] = {}
    for one in tracks:
        for singer in json.loads(one[3]):
            if singer and int(singer) != artist_id:
                bridges.setdefault(int(singer), one[1])

    fresh = []
    with lock:
        new_tracks = sum(conn.execute(
            "INSERT OR IGNORE INTO tracks (track_id, title, artist, artist_ids, album, album_id,"
            " duration, has_sync) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", one).rowcount
            for one in tracks if one[0])
        for one, two in artists.items():
            if one != artist_id and conn.execute(
                    "INSERT OR IGNORE INTO artists (id, name, found_at, from_id, by_track)"
                    " VALUES (?, ?, datetime('now'), ?, ?)",
                    (one, two, artist_id, bridges.get(one, ""))).rowcount:
                fresh.append({"id": one, "name": two, "by": bridges.get(one, "")})
        conn.execute("UPDATE artists SET done=1 WHERE id=?", (artist_id,))
        conn.commit()
    if watch:
        watch({"kind": "artist", "id": artist_id, "name": name, "tracks": new_tracks,
               "sync": sum(1 for one in tracks if one[7]), "found": fresh})
    return new_tracks, len(fresh)


def lines_of(track_id: int) -> list[dict] | None:
    """Fetch one track's synced lyric and reshape it into our line form.

    The sync arrives as two parallel arrays: `startTimeIndex[i]` in seconds and
    `contents[*].text[i]`. Songs whose `hasSyncLyric` is true still come back without one, so
    the arrays are what decide, not the flag.

    @param {int} track_id - Which track.
    @returns {list[dict] | None} Lines with `at` in ms and `text`, or None when there is no sync.
    """
    lyric = result_of(vibe_get(f"/v3/lyric/{track_id}")).get("lyric") or {}
    sync = lyric.get("syncLyric") or {}
    times = sync.get("startTimeIndex")
    parts = [one for one in (sync.get("contents") or []) if isinstance(one, dict)]
    body = next((one.get("text") for one in parts if one.get("languageType") == "default"),
                (parts[0].get("text") if parts else None))
    if not isinstance(times, list) or not isinstance(body, list):
        return None
    out = [{"at": int(round(float(times[at]) * 1000)), "text": str(body[at]).strip()}
           for at in range(min(len(times), len(body))) if str(body[at] or "").strip()]
    return out or None


def take_lyrics(conn: sqlite3.Connection, lock: threading.Lock, rows: list[tuple], watch=None) -> int:
    """Fetch the lyrics of a batch of tracks and write what came back.

    @param {sqlite3.Connection} conn - The harvest store.
    @param {threading.Lock} lock - Guards writes to the store.
    @param {list[tuple]} rows - `(track_id, title, artist)` rows to fetch.
    @param {callable | None} [watch=None] - Called with each track, for a watcher to draw.
    @returns {int} How many came back with a usable sync.
    """
    def one(row: tuple) -> tuple[tuple, list[dict] | None]:
        try:
            return row, lines_of(row[0])
        except Exception:  # noqa: BLE001
            return row, None

    kept = 0
    with ThreadPoolExecutor(max_workers=HANDS) as pool:
        for row, lines in pool.map(one, rows):
            good = bool(lines) and len(lines) >= LEAST_LINES
            with lock:
                conn.execute(
                    "UPDATE tracks SET state=?, lines=?, line_count=?, got_at=datetime('now')"
                    " WHERE track_id=?",
                    ("synced" if good else "nosync",
                     json.dumps(lines, ensure_ascii=False) if good else None,
                     len(lines) if lines else 0, row[0]))
            kept += good
            if watch:
                watch({"kind": "lyric", "id": row[0], "title": row[1] if len(row) > 1 else "",
                       "artist": row[2] if len(row) > 2 else "", "lines": len(lines or []),
                       "ok": bool(good), "first": (lines or [{}])[0].get("text", "") if good else ""})
    with lock:
        conn.commit()
    return kept


def main() -> int:
    """Harvest until the target count of synced songs is reached or the queue runs dry.

    @returns {int} 0 always.
    """
    want = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 1000
    conn = open_db(os.environ.get("MORA_VIBE_DB", "vibe.db"))
    lock = threading.Lock()

    if "--새로" in sys.argv or not conn.execute("SELECT 1 FROM artists LIMIT 1").fetchone():
        print(f"  씨앗 아티스트 {seed_artists(conn, lock)} 명", flush=True)

    began = time.time()
    while True:
        synced = conn.execute("SELECT COUNT(*) FROM tracks WHERE state='synced'").fetchone()[0]
        waiting = conn.execute(
            "SELECT COUNT(*) FROM tracks WHERE state='new' AND has_sync=1"
            " AND duration BETWEEN ? AND ?", (LEAST_SECONDS, MOST_SECONDS)).fetchone()[0]
        left = conn.execute("SELECT COUNT(*) FROM artists WHERE done=0").fetchone()[0]
        print(f"  줄 시각 있는 곡 {synced} · 받을 곡 {waiting} · 남은 아티스트 {left}"
              f" · {time.time() - began:.0f}초", flush=True)
        if synced >= want:
            break

        #: 받을 곡이 쌓여 있으면 가사부터. 아티스트 훑기는 곡이 떨어졌을 때만 — 목록은 값싸고
        #: 가사는 비싸서, 둘을 번갈아야 한쪽만 잔뜩 쌓이지 않는다.
        if waiting:
            rows = conn.execute(
                "SELECT track_id, title, artist FROM tracks WHERE state='new' AND has_sync=1"
                " AND duration BETWEEN ? AND ? LIMIT 200", (LEAST_SECONDS, MOST_SECONDS)).fetchall()
            take_lyrics(conn, lock, rows)
            continue
        if not left:
            print("  더 볼 아티스트가 없다", flush=True)
            break
        for artist_id, name in conn.execute(
                "SELECT id, name FROM artists WHERE done=0 LIMIT 12").fetchall():
            got, more = take_artist(conn, lock, artist_id, name)
            print(f"    {name}: 새 곡 {got} · 새 아티스트 {more}", flush=True)

    rows = conn.execute(
        "SELECT COUNT(*), SUM(line_count), SUM(duration)/3600.0 FROM tracks WHERE state='synced'").fetchone()
    print(f"\n  곡 {rows[0]} · 줄 {rows[1] or 0} · 소리 {rows[2] or 0:.1f}시간", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
