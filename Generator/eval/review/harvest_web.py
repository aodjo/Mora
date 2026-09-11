#!/usr/bin/env python3
"""**수확을 브라우저에서 지켜보고 씨앗을 넣는다.** 크롤이 한 걸음 뗄 때마다 그 걸음을 로그 한 줄로
흘려보내고, 화면은 그것을 콘솔처럼 받는다. 곡·줄·남은 아티스트는 머리에 계속 새로 찍힌다.

그림(캔버스에 번지는 점)은 걷어냈다 — 점이 늘 때마다 힘이 튀어 화면이 흔들렸고, 정작 볼 것인
「어디로 번지는가」는 로그 한 줄에 다 들어간다: 어느 곡이 다리가 되어 누구에게 건너갔는지.

크롤은 이 서버가 소유한다. 같은 장부에 두 크롤이 붙으면 서로의 일을 두 번 하므로, 터미널에서 돌던
`harvest.py` 는 멈추고 여기서 시작·멈춤을 누른다. 걸음은 `harvest.log` 에도 그대로 쌓이니
`tail -f` 도 그대로 된다.

**바깥에 열지 않는다.** 127.0.0.1 에만 묶는다.

@example
  ./.venv/bin/python harvest_web.py          # http://127.0.0.1:8799
"""
import collections
import json
import os
import queue
import sqlite3
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import harvest  # noqa: E402

#: 화면으로 흘려보낼 줄. 보는 사람이 없어도 크롤은 돌아야 하므로 넘치면 오래된 것부터 버린다.
STEPS: "queue.Queue[dict]" = queue.Queue(maxsize=2000)
#: 새로 연 창이 곧바로 읽을 수 있도록 남겨 두는 지난 줄.
RECENT: "collections.deque[dict]" = collections.deque(maxlen=300)
#: 크롤의 지금 상태.
STATE: dict = {"도는 중": False, "지금": "멈춰 있음", "곡": 0, "줄": 0, "아티스트": 0,
               "남은 아티스트": 0, "받을 곡": 0, "같은 곡": 0}
HERE = Path(__file__).parent
DB = os.environ.get("MORA_VIBE_DB", "vibe.db")
LOG = "harvest.log"
#: 도는 중에 들어온 씨앗. 장부에 쓰는 쪽은 크롤 하나로 두고, 여기서는 줄만 세운다 — 둘이 같이 쓰면
#: SQLite 가 잠기고, 기다리게 해도 크롤이 느려진다.
WAITING: list[str] = []
_hand: threading.Thread | None = None
_stop = threading.Event()


def push(step: dict) -> None:
    """Send one step to every watching page, and append its line to the log file.

    @param {dict} step - What just happened, as the crawl reports it.
    @returns {None}
    """
    said = (step.get("line") or "") if step.get("kind") == "note" else (
        harvest.line_of(step) if step.get("kind") in ("seed", "artist", "lyric") else "")
    if said:
        with open(LOG, "a", encoding="utf-8") as file:
            file.write(said + "\n")
    out = {"kind": step.get("kind"), "line": said, **{k: v for k, v in step.items() if k != "kind"}}
    if said:
        RECENT.append({"kind": out["kind"], "line": said})
    try:
        STEPS.put_nowait(out)
    except queue.Full:
        try:
            STEPS.get_nowait()
            STEPS.put_nowait(out)
        except queue.Empty:
            pass


def counts(conn: sqlite3.Connection) -> dict:
    """Read the running totals out of the store.

    @param {sqlite3.Connection} conn - The harvest store.
    @returns {dict} Songs with a sync, lines, artists seen, artists left, tracks waiting.
    """
    got = conn.execute(
        "SELECT COUNT(*), COALESCE(SUM(line_count), 0) FROM tracks WHERE state='synced'").fetchone()
    return {
        "곡": got[0], "줄": got[1],
        "같은 곡": conn.execute("SELECT COUNT(*) FROM tracks WHERE state='dup'").fetchone()[0],
        "아티스트": conn.execute("SELECT COUNT(*) FROM artists").fetchone()[0],
        "남은 아티스트": conn.execute("SELECT COUNT(*) FROM artists WHERE done=0").fetchone()[0],
        "받을 곡": conn.execute(
            "SELECT COUNT(*) FROM tracks WHERE state='new' AND has_sync=1"
            " AND duration BETWEEN ? AND ?",
            (harvest.LEAST_SECONDS, harvest.MOST_SECONDS)).fetchone()[0],
    }


def crawl(words: list[str], want: int) -> None:
    """Walk the crawl, reporting every step, until the target is met or someone stops it.

    Lyrics come first whenever any are waiting: the artist listing is cheap and the lyric fetch is
    what actually produces the thing being harvested.

    @param {list[str]} words - Seed words to search before walking.
    @param {int} want - Stop once this many songs carry a sync.
    @returns {None}
    """
    conn = harvest.open_db(DB)
    lock = threading.Lock()
    STATE["도는 중"] = True
    push({"kind": "state", **STATE})

    fresh = harvest.seeds_left(conn, words)
    if fresh:
        STATE["지금"] = f"씨앗 {len(fresh)}낱말 검색 중"
        push({"kind": "state", **STATE})
        got = harvest.seed_artists(conn, lock, fresh, watch=push)
        push({"kind": "note", "line": f"{time.strftime('%H:%M:%S')} 씨앗  {len(fresh)}낱말 검색"
                                      f" · 새 아티스트 {got}"})

    while not _stop.is_set():
        #: 같은 녹음의 다른 벌은 셈에서도 빼고 가사도 받지 않는다. 목록을 새로 받을 때마다 새 벌이
        #: 딸려 오므로 고리마다 접는다.
        folded, _ = harvest.fold_same(conn, lock)
        if folded:
            push({"kind": "note", "line": f"{time.strftime('%H:%M:%S')} 접음  같은 곡 {folded:,}벌"})

        while WAITING:
            word = WAITING.pop(0)
            STATE["지금"] = f"씨앗 «{word}» 검색 중"
            push({"kind": "state", **STATE})
            harvest.seed_artists(conn, lock, [word], watch=push)

        now = counts(conn)
        STATE.update(now)
        push({"kind": "count", **now})
        #: 목표는 0 이면 없는 것으로 본다. 바이브가 닫히는 마당에 「2 만 곡에서 스스로 멈춤」은
        #: 도움이 안 된다 — 아티스트가 마를 때까지 간다.
        if (want and now["곡"] >= want) or (not now["받을 곡"] and not now["남은 아티스트"]):
            break

        if now["받을 곡"]:
            rows = conn.execute(
                "SELECT track_id, title, artist FROM tracks WHERE state='new' AND has_sync=1"
                " AND duration BETWEEN ? AND ? LIMIT 40",
                (harvest.LEAST_SECONDS, harvest.MOST_SECONDS)).fetchall()
            STATE["지금"] = f"가사 {len(rows)} 곡 받는 중"
            push({"kind": "state", **STATE})
            harvest.take_lyrics(conn, lock, rows, watch=push)
            continue

        #: **방금 심은 씨앗을 먼저 훑는다.** 씨앗에서 나온 아티스트도 그냥 줄 맨 뒤에 서면, 앞에
        #: 천육백 명이 있는 한 영영 차례가 안 온다 — 씨앗을 심는 뜻이 사라진다. 씨앗에서 나온
        #: 아티스트를 앞으로 당기고, 그 안에서는 늦게 심은 것부터. 나머지는 찾은 차례 그대로다.
        for artist_id, name in conn.execute(
                "SELECT id, name FROM artists WHERE done=0"
                " ORDER BY (seed IS NOT NULL) DESC,"
                " (CASE WHEN seed IS NOT NULL THEN found_at ELSE '' END) DESC, rowid"
                " LIMIT 4").fetchall():
            if _stop.is_set():
                break
            STATE["지금"] = f"{name} 의 곡 목록"
            push({"kind": "state", **STATE})
            harvest.take_artist(conn, lock, artist_id, name, watch=push)

    STATE.update(counts(conn))
    STATE["도는 중"] = False
    STATE["지금"] = "멈춤"
    push({"kind": "state", **STATE})
    conn.close()


def start(want: int) -> bool:
    """Start the crawl in the background if it is not already running.

    @param {int} want - Target number of synced songs.
    @returns {bool} True when this call started it.
    """
    global _hand
    if _hand and _hand.is_alive():
        return False
    _stop.clear()
    _hand = threading.Thread(target=crawl, args=(harvest.seed_words(), want), daemon=True)
    _hand.start()
    return True


def add_seeds(words: list[str]) -> dict:
    """Write new seed words into `seeds.txt` and search them straight away.

    The file is the list of record, so a word added here is still there the next time anything
    runs — including the plain `harvest.py` from a terminal.

    @param {list[str]} words - Words to add.
    @returns {dict} What was added and how many artists the search turned up.
    """
    had = harvest.seed_words()
    fresh = [one for one in words if one and one not in had]
    where = HERE / "seeds.txt"
    if not where.exists():
        where.write_text("\n".join(had) + "\n", encoding="utf-8")
    if fresh:
        with open(where, "a", encoding="utf-8") as file:
            file.write("\n".join(fresh) + "\n")
        if STATE["도는 중"]:
            #: 도는 중에는 크롤에게 넘긴다. 장부에 쓰는 쪽은 하나여야 한다.
            WAITING.extend(fresh)
            push({"kind": "note", "line": f"{time.strftime('%H:%M:%S')} 씨앗  "
                                          f"{', '.join(fresh)} · 검색하고 먼저 훑는다"})
        else:
            conn = harvest.open_db(DB)
            harvest.seed_artists(conn, threading.Lock(), fresh, watch=push)
            conn.close()
    return {"넣음": fresh, "이미 있음": [one for one in words if one in had],
            "기다림": len(WAITING)}


def make_app():
    """Build the little FastAPI app that serves the console and the stream.

    @returns {FastAPI} The app, ready for uvicorn.
    """
    from fastapi import FastAPI, Request
    from fastapi.responses import FileResponse, StreamingResponse

    app = FastAPI(title="수확 지켜보기")

    @app.get("/")
    def page():
        """Serve the console page.

        @returns {FileResponse} The page.
        """
        return FileResponse(HERE / "harvest_web.html", media_type="text/html; charset=utf-8")

    @app.get("/api/state")
    def state():
        """Hand a page the totals, the seed words and the recent lines.

        @returns {dict} Everything a freshly opened console needs.
        """
        #: 셈은 언제나 장부에서 읽는다. 크롤이 도는 동안 화면 숫자를 크롤이 밀어 주기는 하지만,
        #: 방금 띄운 서버는 첫 셈을 밀기 전이라 0 이 찍힌다 — 장부에 만 곡이 있는데도.
        if os.path.exists(DB):
            conn = sqlite3.connect(DB)
            STATE.update(counts(conn))
            conn.close()
        return {**STATE, "씨앗": harvest.seed_words(), "지난 줄": list(RECENT)}

    @app.post("/api/start")
    async def begin(request: Request):
        """Start the crawl.

        @param {Request} request - Carries `{"목표": 20000}`.
        @returns {dict} Whether this call started it.
        """
        asked = await request.json() if await request.body() else {}
        return {"시작": start(int(asked.get("목표") or 0))}

    @app.post("/api/stop")
    def halt():
        """Ask the crawl to stop after the step it is on.

        @returns {dict} Confirmation.
        """
        _stop.set()
        STATE["지금"] = "멈추는 중"
        return {"멈춤": True}

    @app.post("/api/seed")
    async def seed(request: Request):
        """Add seed words, saving them to the file and searching them now.

        @param {Request} request - Carries `{"낱말": "잔나비, 검정치마"}`.
        @returns {dict} What was added.
        """
        asked = await request.json()
        words = [one.strip() for one in str(asked.get("낱말", "")).replace(",", "\n").split("\n")
                 if one.strip()]
        return add_seeds(words)

    @app.get("/api/artists")
    def artists(q: str = "", limit: int = 400):
        """List the artists in the store, most synced songs first, for the left column.

        One folder per **person**, not per credit line. Grouping by the artist string on the track
        made a folder called 「권인하, 김광석, 우현, 이서환, 장현…」 holding one song, and the name
        did not even fit the column. A track's `artist_ids` is opened with `json_each` so a song
        shows up under everyone who sang it.

        @param {str} [q=""] - Filter on the artist's name.
        @param {int} [limit=400] - How many to return.
        @returns {list[dict]} Artists with song counts and line totals.
        """
        conn = sqlite3.connect(DB)
        where, args = "", []
        if q:
            where = " WHERE a.name LIKE ?"
            args = [f"%{q}%"]
        rows = conn.execute(
            "SELECT a.id, a.name, COUNT(*),"
            " SUM(CASE WHEN t.state='synced' THEN 1 ELSE 0 END), COALESCE(SUM(t.line_count), 0)"
            " FROM tracks t, json_each(t.artist_ids) j JOIN artists a ON a.id = j.value" + where +
            " GROUP BY a.id ORDER BY 4 DESC, 3 DESC LIMIT ?", args + [limit]).fetchall()
        conn.close()
        return [{"번호": one[0], "이름": one[1] or "(이름 없음)", "곡": one[2],
                 "시각 있는 곡": one[3], "줄": one[4]} for one in rows]

    @app.get("/api/tracks")
    def tracks(artist_id: int = 0, q: str = "", limit: int = 500, every: int = 0):
        """List one artist's songs, folding the copies of the same recording into one row.

        Vibe lists the same recording once per album it appears on — a single, a best-of and two
        compilations give 「사랑이라는 이유로」 four times, each with its own track id. For reading
        and for training data they are one song. Copies are folded by title and the best one is
        kept: a synced copy over an unsynced one, then the one with the most lines, then the
        longest. `every=1` unfolds them.

        @param {int} [artist_id=0] - Whose songs to list; every song they are credited on.
        @param {str} [q=""] - Filter on song title or credit line.
        @param {int} [limit=500] - How many to return.
        @param {int} [every=0] - 1 to list every copy instead of folding them.
        @returns {list[dict]} Songs with duration, state, line count and how many copies exist.
        """
        conn = sqlite3.connect(DB)
        where, args = [], []
        if artist_id:
            where.append("EXISTS (SELECT 1 FROM json_each(tracks.artist_ids) j WHERE j.value = ?)")
            args.append(artist_id)
        if q:
            where.append("(title LIKE ? OR artist LIKE ?)")
            args += [f"%{q}%", f"%{q}%"]
        filter_on = (" WHERE " + " AND ".join(where)) if where else ""
        if every:
            rows = conn.execute(
                "SELECT track_id, title, album, duration, state, COALESCE(line_count, 0), artist, 1"
                " FROM tracks" + filter_on +
                " ORDER BY state='synced' DESC, line_count DESC, title LIMIT ?",
                args + [limit]).fetchall()
        else:
            rows = conn.execute(
                "SELECT track_id, title, album, duration, state, lines, artist, copies FROM ("
                "  SELECT track_id, title, album, duration, state, COALESCE(line_count, 0) AS lines,"
                "    artist,"
                "    COUNT(*) OVER (PARTITION BY lower(trim(title))) AS copies,"
                "    ROW_NUMBER() OVER (PARTITION BY lower(trim(title))"
                "      ORDER BY (state='synced') DESC, COALESCE(line_count, 0) DESC, duration DESC)"
                "      AS pick"
                "  FROM tracks" + filter_on +
                ") WHERE pick = 1 ORDER BY state='synced' DESC, lines DESC, title LIMIT ?",
                args + [limit]).fetchall()
        conn.close()
        return [{"번호": one[0], "제목": one[1], "앨범": one[2], "길이": one[3],
                 "상태": one[4], "줄": one[5], "아티스트": one[6], "벌": one[7]} for one in rows]

    @app.get("/api/track/{track_id}")
    def track(track_id: int):
        """Hand over one song's timed lines.

        @param {int} track_id - Which song.
        @returns {dict} The song with its lines, each carrying `at` in ms.
        """
        conn = sqlite3.connect(DB)
        row = conn.execute(
            "SELECT track_id, title, artist, album, duration, state, lines, line_count"
            " FROM tracks WHERE track_id=?", (track_id,)).fetchone()
        conn.close()
        if not row:
            return {"없음": True}
        return {"번호": row[0], "제목": row[1], "아티스트": row[2], "앨범": row[3], "길이": row[4],
                "상태": row[5], "줄 수": row[7], "줄": json.loads(row[6]) if row[6] else []}

    @app.get("/stream")
    def stream():
        """Stream every step of the crawl to the page as server-sent events.

        @returns {StreamingResponse} An endless `text/event-stream`.
        """
        def wire():
            yield f"data: {json.dumps({'kind': 'state', **STATE}, ensure_ascii=False)}\n\n"
            while True:
                try:
                    step = STEPS.get(timeout=15)
                except queue.Empty:
                    yield ": 쉼\n\n"
                    continue
                yield f"data: {json.dumps(step, ensure_ascii=False)}\n\n"

        return StreamingResponse(wire(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    return app


def main() -> int:
    """Serve the console on localhost.

    @returns {int} 0 always.
    """
    import uvicorn
    port = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 8799
    print(f"  http://127.0.0.1:{port}  · 씨앗 {len(harvest.seed_words())} 낱말 · 장부 {DB}", flush=True)
    uvicorn.run(make_app(), host="127.0.0.1", port=port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
