#!/usr/bin/env python3
"""**수확이 번지는 것을 실시간으로 본다.** 씨앗 낱말에서 시작해 어느 곡을 다리로 어느 아티스트로
건너가는지, 어떤 곡에 줄 시각이 붙어 있는지가 브라우저에서 자라난다.

로그로는 수가 늘어나는 것만 보이고 **어디로** 번지는지는 안 보인다. 씨앗을 하나 더 넣었을 때 그것이
새 구석을 여는지 이미 지나온 자리로 되돌아오는지도 로그로는 모른다. 그래서 크롤러가 한 걸음 뗄 때마다
그 걸음을 그대로 흘려보내고, 화면이 점과 선으로 받는다.

크롤은 `harvest.py` 그대로다 — 여기서는 고리를 돌리며 걸음마다 `watch` 로 받은 것을 줄 세워
`/stream`(SSE)으로 내보낼 뿐이다. 저장도 같은 `vibe.db` 에 한다.

**바깥에 열지 않는다.** 127.0.0.1 에만 묶는다. 남의 API 를 부르는 것이고, 여는 열쇠가 없다.

@example
  ./.venv/bin/python harvest_web.py          # http://127.0.0.1:8799
  MORA_VIBE_DB=vibe.db ./.venv/bin/python harvest_web.py 8799
"""
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

#: 화면에 흘려보낼 걸음을 담아 두는 줄. 보는 사람이 없어도 크롤은 돌아야 하므로, 넘치면 오래된
#: 걸음부터 버린다 — 그림은 최신 상태만 맞으면 된다.
STEPS: "queue.Queue[dict]" = queue.Queue(maxsize=2000)
#: 크롤의 지금 상태. 뒤늦게 창을 연 사람에게 한 번에 건넨다.
STATE: dict = {"도는 중": False, "지금": "", "곡": 0, "줄": 0, "아티스트": 0, "남은 아티스트": 0,
               "받을 곡": 0, "장부": ""}
#: 진짜 장부와, 처음부터 번지는 것을 보려고 쓰는 따로 장부. 후자는 「처음부터」를 누를 때마다 비운다.
DB_REAL = os.environ.get("MORA_VIBE_DB", "vibe.db")
DB_WATCH = "watch.db"
_hand: threading.Thread | None = None
_stop = threading.Event()


def push(step: dict) -> None:
    """Put one step of the crawl on the wire, dropping the oldest when nobody is draining it.

    @param {dict} step - What just happened, as the page's drawing code expects it.
    @returns {None}
    """
    try:
        STEPS.put_nowait(step)
    except queue.Full:
        try:
            STEPS.get_nowait()
            STEPS.put_nowait(step)
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
        "아티스트": conn.execute("SELECT COUNT(*) FROM artists").fetchone()[0],
        "남은 아티스트": conn.execute("SELECT COUNT(*) FROM artists WHERE done=0").fetchone()[0],
        "받을 곡": conn.execute(
            "SELECT COUNT(*) FROM tracks WHERE state='new' AND has_sync=1"
            " AND duration BETWEEN ? AND ?",
            (harvest.LEAST_SECONDS, harvest.MOST_SECONDS)).fetchone()[0],
    }


def graph_of(where: str, most: int = 900) -> dict:
    """Read the crawl's shape back out of a store, so a page opened late still sees the picture.

    @param {str} where - Which store to read.
    @param {int} [most=900] - How many artists to hand over, oldest first.
    @returns {dict} Artists with who found them, and how many tracks each brought in.
    """
    if not os.path.exists(where):
        return {"점": [], "장부": where}
    conn = sqlite3.connect(where)
    rows = conn.execute(
        "SELECT a.id, a.name, a.from_id, a.by_track, a.seed, a.done,"
        " (SELECT COUNT(*) FROM tracks t WHERE t.artist_ids LIKE '%' || a.id || '%')"
        " FROM artists a ORDER BY a.rowid LIMIT ?", (most,)).fetchall()
    conn.close()
    return {"장부": where, "점": [
        {"id": one[0], "name": one[1], "from": one[2], "by": one[3] or "", "seed": one[4] or "",
         "done": one[5], "tracks": one[6]} for one in rows]}


def crawl(words: list[str], want: int) -> None:
    """Walk the crawl, sending every step to the page until the target is met or someone stops it.

    Lyrics come first whenever any are waiting: the artist listing is cheap and the lyric fetch is
    what actually produces the thing being harvested, so leaning the other way would pile up a
    queue nobody drains.

    @param {list[str]} words - Seed words to search before walking.
    @param {int} want - Stop once this many songs carry a sync.
    @returns {None}
    """
    conn = harvest.open_db(STATE["장부"] or DB_REAL)
    lock = threading.Lock()
    STATE["도는 중"] = True
    push({"kind": "state", **STATE})

    fresh = [one for one in words
             if not conn.execute("SELECT 1 FROM artists WHERE name=?", (one,)).fetchone()]
    if fresh:
        STATE["지금"] = f"씨앗 {len(fresh)} 낱말 검색"
        harvest.seed_artists(conn, lock, fresh, watch=push)

    while not _stop.is_set():
        now = counts(conn)
        STATE.update(now)
        push({"kind": "count", **now})
        if now["곡"] >= want or (not now["받을 곡"] and not now["남은 아티스트"]):
            break

        if now["받을 곡"]:
            rows = conn.execute(
                "SELECT track_id, title, artist FROM tracks WHERE state='new' AND has_sync=1"
                " AND duration BETWEEN ? AND ? LIMIT 40",
                (harvest.LEAST_SECONDS, harvest.MOST_SECONDS)).fetchall()
            STATE["지금"] = f"가사 {len(rows)} 곡 받는 중"
            harvest.take_lyrics(conn, lock, rows, watch=push)
            continue

        for artist_id, name in conn.execute(
                "SELECT id, name FROM artists WHERE done=0 LIMIT 4").fetchall():
            if _stop.is_set():
                break
            STATE["지금"] = f"{name} 의 곡 목록"
            harvest.take_artist(conn, lock, artist_id, name, watch=push)

    STATE["도는 중"] = False
    STATE["지금"] = "멈춤"
    push({"kind": "state", **STATE, **counts(conn)})
    conn.close()


def start(words: list[str], want: int, afresh: bool = False) -> bool:
    """Start the crawl in the background if it is not already running.

    @param {list[str]} words - Seed words for this run.
    @param {int} want - Target number of synced songs.
    @param {bool} [afresh=False] - Walk an empty store, to watch the spread from the first seed.
    @returns {bool} True when this call started it.
    """
    global _hand
    if _hand and _hand.is_alive():
        return False
    STATE["장부"] = DB_WATCH if afresh else DB_REAL
    if afresh:
        for tail in ("", "-wal", "-shm"):
            if os.path.exists(DB_WATCH + tail):
                os.remove(DB_WATCH + tail)
        push({"kind": "wipe"})
    _stop.clear()
    _hand = threading.Thread(target=crawl, args=(words, want), daemon=True)
    _hand.start()
    return True


def make_app():
    """Build the little FastAPI app that serves the page and the stream.

    @returns {FastAPI} The app, ready for uvicorn.
    """
    from fastapi import FastAPI, Request
    from fastapi.responses import FileResponse, StreamingResponse

    app = FastAPI(title="수확 지켜보기")
    here = Path(__file__).parent

    @app.get("/")
    def page():
        """Serve the watching page.

        @returns {FileResponse} The page.
        """
        return FileResponse(here / "harvest_web.html", media_type="text/html; charset=utf-8")

    @app.get("/api/state")
    def state():
        """Hand a late-joining page the running totals and the seed words in use.

        @returns {dict} The crawl state.
        """
        return {**STATE, "씨앗 목록": harvest.seed_words()}

    @app.get("/api/graph")
    def graph():
        """Hand a page the shape already walked, so a reload does not lose the picture.

        @returns {dict} Artists and who found them, from whichever store is in play.
        """
        return graph_of(STATE["장부"] or DB_REAL)

    @app.post("/api/start")
    async def begin(request: Request):
        """Start the crawl.

        @param {Request} request - Carries `{"씨앗": [...], "목표": 20000, "처음부터": false}`.
        @returns {dict} Whether it started, and which store it walks.
        """
        asked = await request.json() if await request.body() else {}
        words = harvest.seed_words(asked.get("씨앗") or [])
        began = start(words, int(asked.get("목표") or 20000), bool(asked.get("처음부터")))
        return {"시작": began, "장부": STATE["장부"]}

    @app.post("/api/seed")
    async def seed(request: Request):
        """Add seed words while it runs, searching them straight away.

        @param {Request} request - Carries `{"낱말": "아이유, 잔나비"}`.
        @returns {dict} How many artists the words turned up.
        """
        asked = await request.json()
        words = [one.strip() for one in str(asked.get("낱말", "")).replace(",", "\n").split("\n")
                 if one.strip()]
        if not words:
            return {"넣음": 0}
        conn = harvest.open_db(STATE["장부"] or DB_REAL)
        got = harvest.seed_artists(conn, threading.Lock(), words, watch=push)
        conn.close()
        return {"넣음": got, "낱말": words}

    @app.post("/api/stop")
    def halt():
        """Ask the crawl to stop after the step it is on.

        @returns {dict} The state.
        """
        _stop.set()
        return {"멈춤": True}

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
    """Serve the watching page on localhost.

    @returns {int} 0 always.
    """
    import uvicorn
    port = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 8799
    print(f"  http://127.0.0.1:{port}  · 씨앗 {len(harvest.seed_words())} 낱말", flush=True)
    uvicorn.run(make_app(), host="127.0.0.1", port=port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
