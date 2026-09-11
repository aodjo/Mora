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
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import fetch_audio  # noqa: E402
import harvest  # noqa: E402

#: 음원 쪽 기록과 음원을 둘 곳. 음원 받기(`fetch_audio.py`)를 터미널에서 돌려도 같은 곳을 쓴다.
AUDIO_BOOK = os.environ.get("MORA_AUDIO_BOOK", "audio.db")
AUDIO_OUT = os.environ.get("MORA_AUDIO_OUT", "vibe_audio")
#: 대시보드에서 띄운 음원 받기 판의 상태.
AUDIO_RUN: dict = {"도는 중": False, "total": 0, "done": 0, "dry": False, "tally": {}}
_audio_hand: "threading.Thread | None" = None
_audio_halt = threading.Event()

#: 화면으로 흘려보낼 줄. 보는 사람이 없어도 크롤은 돌아야 하므로 넘치면 오래된 것부터 버린다.
STEPS: "queue.Queue[dict]" = queue.Queue(maxsize=2000)
#: 새로 연 창이 곧바로 읽을 수 있도록 남겨 두는 지난 줄.
RECENT: "collections.deque[dict]" = collections.deque(maxlen=300)
#: 크롤의 지금 상태.
STATE: dict = {"도는 중": False, "지금": "멈춰 있음", "곡": 0, "줄": 0, "아티스트": 0,
               "남은 아티스트": 0, "받을 곡": 0, "같은 곡": 0, "막힘": 0, "쉼 배": 1.0, "훑기": True}
HERE = Path(__file__).parent
DB = os.environ.get("MORA_VIBE_DB", "vibe.db")
LOG = "harvest.log"
#: 도는 중에 들어온 씨앗. 장부에 쓰는 쪽은 크롤 하나로 두고, 여기서는 줄만 세운다 — 둘이 같이 쓰면
#: SQLite 가 잠기고, 기다리게 해도 크롤이 느려진다.
WAITING: list[str] = []
#: 사람이 목록에서 「먼저 훑기」를 누른 아티스트. 안 훑은 줄이 천팔백 명이라, 보고 있는 그 사람을
#: 지금 훑을 방법이 없으면 목록은 영영 비어 보인다.
HOT: list[int] = []
#: 아티스트 훑기 스위치. 끄면 가사만 받는다 — 훑다가 찾은 아티스트는 「안 훑음」으로 장부에 남아
#: 기다리고, 다시 켜면 그 줄부터 훑는다. 「먼저 훑기」로 콕 집은 사람은 꺼져 있어도 훑는다.
SETTINGS: dict = {"훑기": True}
#: 막힌 곡(403)을 로그인 세션으로 받는 중인지. 켜지면 가사 일꾼이 보통 곡보다 이것을 먼저 한다.
LOGIN_PASS = threading.Event()
#: 이번 로그인 판을 시작한 시각(장부의 `got_at` 과 같은 꼴). 그 뒤에 받은 곡은 다시 집지 않는다.
LOGIN_SINCE = [""]


def load_settings() -> None:
    """Read the switches back out of the store, so a restart keeps them as they were.

    @returns {None}
    """
    conn = harvest.open_db(DB)
    row = conn.execute("SELECT value FROM settings WHERE key='훑기'").fetchone()
    conn.close()
    if row:
        SETTINGS["훑기"] = row[0] == "1"
    STATE["훑기"] = SETTINGS["훑기"]


def save_setting(key: str, on: bool) -> None:
    """Write one switch into the store.

    @param {str} key - Which switch.
    @param {bool} on - Its new position.
    @returns {None}
    """
    conn = harvest.open_db(DB)
    conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, "1" if on else "0"))
    conn.commit()
    conn.close()
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
        "막힌 곡": conn.execute("SELECT COUNT(*) FROM tracks WHERE state='forbidden'").fetchone()[0],
        "아티스트": conn.execute("SELECT COUNT(*) FROM artists").fetchone()[0],
        "남은 아티스트": conn.execute("SELECT COUNT(*) FROM artists WHERE done=0").fetchone()[0],
        "받을 곡": conn.execute(
            "SELECT COUNT(*) FROM tracks WHERE state='new' AND has_sync=1"
            " AND duration BETWEEN ? AND ?",
            (harvest.LEAST_SECONDS, harvest.MOST_SECONDS)).fetchone()[0],
    }


def crawl(words: list[str], want: int) -> None:
    """Walk the crawl, reporting every step, until the target is met or someone stops it.

    Seeds are searched first; then two workers run side by side — one fetching lyrics, one
    walking artists — while this thread folds duplicates, takes in new seeds and keeps the
    totals on the page current.

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

    #: **가사 받기와 아티스트 훑기를 따로 돌린다.** 하나의 고리에서 번갈아 할 때는 받을 곡이 쌓이면
    #: 훑기가 멈췄고(1 분에 0 명), 훑기가 멈추면 곧 받을 곡이 마른다. 둘은 서로 다른 장부 칸을 쓰므로
    #: 각자의 실에서 각자의 연결로 돈다 — 쓰기만 `lock` 하나로 줄 세운다.
    over = threading.Event()
    hands = [threading.Thread(target=lyric_loop, args=(lock, over), daemon=True),
             threading.Thread(target=walk_loop, args=(lock, over), daemon=True)]
    for one in hands:
        one.start()

    tick = 0
    while not _stop.is_set():
        while WAITING:
            word = WAITING.pop(0)
            push({"kind": "note", "line": f"{time.strftime('%H:%M:%S')} 씨앗  «{word}» 검색"})
            harvest.seed_artists(conn, lock, [word], watch=push)

        #: 같은 녹음의 다른 벌은 셈에서도 빼고 가사도 받지 않는다. 표 전체를 훑는 일이라 30 초에 한 번.
        if tick % 10 == 0:
            folded, _ = harvest.fold_same(conn, lock)
            if folded:
                push({"kind": "note", "line": f"{time.strftime('%H:%M:%S')} 접음  같은 곡 {folded:,}벌"})
        tick += 1

        now = counts(conn)
        STATE.update(now)
        STATE["막힘"] = harvest.PACE["막힘"]
        STATE["쉼 배"] = round(harvest.PACE["배"], 1)
        STATE["지금"] = " · ".join(one for one in (DOING["가사"], DOING["훑기"]) if one) or "쉬는 중"
        push({"kind": "count", **now, "막힘": STATE["막힘"], "쉼 배": STATE["쉼 배"]})
        push({"kind": "state", **STATE})
        #: 목표는 0 이면 없는 것으로 본다. 둘 다 할 일이 없을 때만 끝낸다.
        if (want and now["곡"] >= want) or (not now["받을 곡"] and not now["남은 아티스트"] and not HOT):
            break
        time.sleep(3)

    over.set()
    for one in hands:
        one.join(timeout=60)
    STATE.update(counts(conn))
    STATE["도는 중"] = False
    STATE["지금"] = "멈춤"
    DOING["가사"] = DOING["훑기"] = ""
    push({"kind": "state", **STATE})
    conn.close()


#: 두 일꾼이 지금 하는 일. 머리띠의 「지금」은 이 둘을 이어 붙인 것이다.
DOING: dict = {"가사": "", "훑기": ""}


def lyric_loop(lock: threading.Lock, over: threading.Event) -> None:
    """Keep fetching lyrics for waiting songs, `HANDS` at a time, until told to stop.

    @param {threading.Lock} lock - Guards writes to the store.
    @param {threading.Event} over - Set when the crawl ends on its own.
    @returns {None}
    """
    conn = harvest.open_db(DB)
    while not (_stop.is_set() or over.is_set()):
        if LOGIN_PASS.is_set():
            #: 로그인으로 막힌 곡을 받는다 — 두 곡씩, 느리게. 받아도 403 이면 그대로 막힌 곡으로 남고
            #: `got_at` 이 새로 찍히므로, 한 번 돈 곡은 이번 판에서 다시 집지 않는다.
            barred = conn.execute(
                "SELECT track_id, title, artist FROM tracks WHERE state='forbidden'"
                " AND (got_at IS NULL OR got_at < ?) LIMIT 20", (LOGIN_SINCE[0],)).fetchall()
            if barred:
                DOING["가사"] = f"로그인으로 막힌 곡 {len(barred)}곡"
                harvest.take_lyrics(conn, lock, barred, watch=push, login=True)
                continue
            LOGIN_PASS.clear()
            push({"kind": "note", "line": f"{time.strftime('%H:%M:%S')} 로그인  막힌 곡 다 돌았다"})
        rows = conn.execute(
            "SELECT track_id, title, artist FROM tracks WHERE state='new' AND has_sync=1"
            " AND duration BETWEEN ? AND ? LIMIT ?",
            (harvest.LEAST_SECONDS, harvest.MOST_SECONDS, harvest.HANDS * 8)).fetchall()
        if not rows:
            DOING["가사"] = ""
            time.sleep(2)
            continue
        DOING["가사"] = f"가사 {len(rows)}곡"
        harvest.take_lyrics(conn, lock, rows, watch=push)
    DOING["가사"] = ""
    conn.close()


_here = threading.local()


def conn_here() -> sqlite3.Connection:
    """The calling thread's own connection to the store, opened on first use.

    A connection shared across threads interleaves cursors and fails; each walker keeps its own
    and WAL lets them read side by side while `lock` lines up the writes.

    @returns {sqlite3.Connection} This thread's connection.
    """
    if not hasattr(_here, "conn"):
        _here.conn = harvest.open_db(DB)
    return _here.conn


def walk_loop(lock: threading.Lock, over: threading.Event) -> None:
    """Keep walking artists, `WALKERS` at a time, until told to stop.

    Artists someone pressed 「먼저 훑기」 on go first, then artists that came from a seed —
    newest seed first — and after them everyone else in the order they were found. An artist
    standing behind eighteen hundred others never gets a turn otherwise, and planting a seed
    would mean nothing.

    @param {threading.Lock} lock - Guards writes to the store.
    @param {threading.Event} over - Set when the crawl ends on its own.
    @returns {None}
    """
    conn = harvest.open_db(DB)
    with ThreadPoolExecutor(max_workers=harvest.WALKERS) as pool:
        while not (_stop.is_set() or over.is_set()):
            picks: list[tuple[int, str]] = []
            while HOT and len(picks) < harvest.WALKERS:
                artist_id = HOT.pop(0)
                row = conn.execute("SELECT name FROM artists WHERE id=?", (artist_id,)).fetchone()
                if row:
                    picks.append((artist_id, row[0]))
            if not picks and not SETTINGS["훑기"]:
                DOING["훑기"] = "훑기 꺼짐"
                time.sleep(2)
                continue
            if SETTINGS["훑기"] and len(picks) < harvest.WALKERS:
                taken = {one for one, _ in picks}
                picks += [one for one in conn.execute(
                    "SELECT id, name FROM artists WHERE done=0"
                    " ORDER BY (seed IS NOT NULL) DESC,"
                    " (CASE WHEN seed IS NOT NULL THEN found_at ELSE '' END) DESC, rowid"
                    " LIMIT ?", (harvest.WALKERS,)).fetchall() if one[0] not in taken]
                picks = picks[:harvest.WALKERS]
            if not picks:
                DOING["훑기"] = ""
                time.sleep(2)
                continue
            DOING["훑기"] = "훑기 " + ", ".join(name for _, name in picks)[:40]
            list(pool.map(
                lambda one: harvest.take_artist(conn_here(), lock, one[0], one[1], watch=push), picks))
    DOING["훑기"] = ""
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


def audio_watch(event: dict) -> None:
    """Pass the audio fetcher's progress on to the dashboard.

    @param {dict} event - A `start` or `song` event from `fetch_audio.run`.
    @returns {None}
    """
    if event["kind"] == "start":
        AUDIO_RUN.update({"total": event["total"], "done": 0, "tally": {}, "dry": event["dry"]})
    else:
        AUDIO_RUN["done"] += 1
        AUDIO_RUN["tally"][event["state"]] = AUDIO_RUN["tally"].get(event["state"], 0) + 1
    push({"kind": "audio-" + event["kind"], **event, "run": dict(AUDIO_RUN)})


def audio_start(limit: int, hands: int, dry: bool) -> bool:
    """Start an audio fetching batch in the background, if none is running.

    @param {int} limit - How many songs.
    @param {int} hands - How many at once.
    @param {bool} dry - Choose only.
    @returns {bool} True when this call started it.
    """
    global _audio_hand
    if _audio_hand and _audio_hand.is_alive():
        return False
    _audio_halt.clear()

    def go() -> None:
        AUDIO_RUN["도는 중"] = True
        try:
            fetch_audio.run(DB, AUDIO_BOOK, AUDIO_OUT, limit, hands, dry, watch=audio_watch,
                            halt=_audio_halt)
        finally:
            AUDIO_RUN["도는 중"] = False
            push({"kind": "audio-end", "run": dict(AUDIO_RUN)})

    _audio_hand = threading.Thread(target=go, daemon=True)
    _audio_hand.start()
    return True


def audio_row(one: tuple) -> dict:
    """Shape one audio record row for the dashboard.

    @param {tuple} one - A row from the list query.
    @returns {dict} The row as the page reads it.
    """
    return {"번호": one[0], "상태": one[1], "영상": one[2], "영상 제목": one[3] or "",
            "채널": one[4] or "", "영상 길이": one[5] or 0, "바이브 길이": one[6] or 0,
            "점수": one[7], "까닭": one[8] or "", "파일": bool(one[9]), "파일 길이": one[10] or 0,
            "때": one[11] or "", "가수": one[12] or "", "제목": one[13] or "", "사람이 고름": bool(one[14])}


def make_app():
    """Build the little FastAPI app that serves the console and the stream.

    @returns {FastAPI} The app, ready for uvicorn.
    """
    from fastapi import FastAPI, Request
    from fastapi.responses import FileResponse, StreamingResponse

    app = FastAPI(title="수확 지켜보기")
    load_settings()

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
        return {**STATE, "씨앗": harvest.seed_words(), "지난 줄": list(RECENT),
                "로그인": bool(harvest.login_cookie()), "쿠키 자리": harvest.COOKIE_FILE}

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

    @app.post("/api/login-pass")
    def login_pass():
        """Fetch the blocked songs' lyrics again with the saved Naver session.

        @returns {dict} Whether a session is saved, and how many songs will be asked for.
        """
        if not harvest.login_cookie():
            return {"시작": False, "까닭": f"로그인 쿠키가 없다 — {harvest.COOKIE_FILE} 에 넣어 주세요"}
        conn = sqlite3.connect(DB)
        barred = conn.execute("SELECT COUNT(*) FROM tracks WHERE state='forbidden'").fetchone()[0]
        LOGIN_SINCE[0] = conn.execute("SELECT datetime('now')").fetchone()[0]
        conn.close()
        LOGIN_PASS.set()
        if not STATE["도는 중"]:
            start(0)
        push({"kind": "note", "line": f"{time.strftime('%H:%M:%S')} 로그인  막힌 곡 {barred:,}곡을"
                                      " 로그인 세션으로 다시 받는다 · 두 곡씩 천천히"})
        return {"시작": True, "막힌 곡": barred}

    @app.post("/api/recheck")
    def recheck():
        """Put songs that came back with no timings back in the queue, to sort the blocked from the empty.

        Before 403 was told apart, a song Vibe refused was written down as 「시각 없음」 like one
        that really has no timings. Asking again anonymously sorts them: a 403 now lands as a
        blocked song, which the login pass can then take.

        @returns {dict} How many songs went back in the queue.
        """
        conn = harvest.open_db(DB)
        back = conn.execute(
            "UPDATE tracks SET state='new' WHERE state='nosync' AND has_sync=1"
            " AND COALESCE(line_count, 0) = 0").rowcount
        conn.commit()
        conn.close()
        if not STATE["도는 중"]:
            start(0)
        push({"kind": "note", "line": f"{time.strftime('%H:%M:%S')} 재확인  시각 없음 {back:,}곡을"
                                      " 다시 받는다 · 403 이면 막힌 곡으로 갈라진다"})
        return {"다시": back}

    @app.post("/api/walking")
    async def walking(request: Request):
        """Switch artist walking on or off. Lyric fetching carries on either way.

        @param {Request} request - Carries `{"켬": true}` or `{"켬": false}`.
        @returns {dict} The switch's new position and how many artists are waiting for it.
        """
        asked = await request.json()
        on = bool(asked.get("켬"))
        SETTINGS["훑기"] = on
        STATE["훑기"] = on
        save_setting("훑기", on)
        conn = sqlite3.connect(DB)
        left = conn.execute("SELECT COUNT(*) FROM artists WHERE done=0").fetchone()[0]
        conn.close()
        push({"kind": "note", "line": f"{time.strftime('%H:%M:%S')} 설정  아티스트 훑기 "
                                      + ("켬 · 기다리던 " + f"{left:,}명부터" if on
                                         else f"끔 · 가사만 받는다 · 찾은 아티스트 {left:,}명은 기다림")})
        push({"kind": "state", **STATE})
        return {"훑기": on, "기다리는 아티스트": left}

    @app.post("/api/walk")
    async def walk(request: Request):
        """Put one artist at the head of the walking queue.

        @param {Request} request - Carries `{"번호": 123}`.
        @returns {dict} Where it stands, and whether the crawl is running to take it.
        """
        asked = await request.json()
        artist_id = int(asked.get("번호") or 0)
        if not artist_id:
            return {"넣음": False}
        if artist_id not in HOT:
            HOT.append(artist_id)
        if not STATE["도는 중"]:
            start(0)
        conn = sqlite3.connect(DB)
        row = conn.execute("SELECT name FROM artists WHERE id=?", (artist_id,)).fetchone()
        conn.close()
        push({"kind": "note", "line": f"{time.strftime('%H:%M:%S')} 먼저  "
                                      f"{row[0] if row else artist_id} · 다음 차례로 올림"})
        return {"넣음": True, "기다림": len(HOT)}

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
            " SUM(CASE WHEN t.state='synced' THEN 1 ELSE 0 END), COALESCE(SUM(t.line_count), 0),"
            " a.done"
            " FROM tracks t, json_each(t.artist_ids) j JOIN artists a ON a.id = j.value" + where +
            " GROUP BY a.id ORDER BY 4 DESC, 3 DESC LIMIT ?", args + [limit]).fetchall()
        #: 곡이 하나도 없는 아티스트도 보여야 한다 — 「먼저 훑기」를 눌러야 할 사람이 바로 그들이다.
        if q:
            seen = {one[0] for one in rows}
            more = conn.execute(
                "SELECT id, name, 0, 0, 0, done FROM artists WHERE name LIKE ? LIMIT ?",
                (f"%{q}%", limit)).fetchall()
            rows = list(rows) + [one for one in more if one[0] not in seen]
        conn.close()
        return [{"번호": one[0], "이름": one[1] or "(이름 없음)", "곡": one[2],
                 "시각 있는 곡": one[3], "줄": one[4], "훑음": one[5]} for one in rows]

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

    @app.get("/api/audio/summary")
    def audio_summary():
        """How the audio side stands: songs per state, disk used, and the batch in flight.

        @returns {dict} Counts, bytes on disk, and the running batch.
        """
        book = fetch_audio.open_book(AUDIO_BOOK)
        counts = dict(book.execute("SELECT state, COUNT(*) FROM audio GROUP BY state").fetchall())
        book.close()
        size = 0
        if os.path.isdir(AUDIO_OUT):
            size = sum(entry.stat().st_size for entry in os.scandir(AUDIO_OUT) if entry.is_file())
        return {"상태별": counts, "디스크": size, "판": dict(AUDIO_RUN)}

    @app.get("/api/audio/list")
    def audio_list(state: str = "", q: str = "", limit: int = 300, offset: int = 0):
        """List songs on the audio side, newest first.

        @param {str} [state=""] - Only this state (picked, got, suspect, miss, fail, wrong).
        @param {str} [q=""] - Filter on artist, title or the chosen upload's title.
        @param {int} [limit=300] - How many.
        @param {int} [offset=0] - Skip this many.
        @returns {list[dict]} Rows for the list.
        """
        book = fetch_audio.open_book(AUDIO_BOOK)
        where, args = [], []
        if state:
            where.append("state = ?")
            args.append(state)
        if q:
            where.append("(artist LIKE ? OR title LIKE ? OR video_title LIKE ?)")
            args += [f"%{q}%"] * 3
        rows = book.execute(
            "SELECT track_id, state, video_id, video_title, channel, video_duration, want_duration,"
            " score, why, file, file_duration, tried_at, artist, title, manual FROM audio" +
            (" WHERE " + " AND ".join(where) if where else "") +
            " ORDER BY tried_at DESC LIMIT ? OFFSET ?", args + [limit, offset]).fetchall()
        book.close()
        return [audio_row(one) for one in rows]

    @app.get("/api/audio/one/{track_id}")
    def audio_one(track_id: int):
        """One song in full: the chosen upload, every candidate, and the first lyric lines to check by ear.

        @param {int} track_id - Which song.
        @returns {dict} The song.
        """
        book = fetch_audio.open_book(AUDIO_BOOK)
        row = book.execute(
            "SELECT track_id, state, video_id, video_title, channel, video_duration, want_duration,"
            " score, why, file, file_duration, tried_at, artist, title, manual, candidates, album"
            " FROM audio WHERE track_id=?", (track_id,)).fetchone()
        book.close()
        if not row:
            return {"없음": True}
        lines = []
        conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
        got = conn.execute("SELECT lines FROM tracks WHERE track_id=?", (track_id,)).fetchone()
        conn.close()
        if got and got[0]:
            lines = json.loads(got[0])[:8]
        return {**audio_row(row), "후보": json.loads(row[15] or "[]"), "앨범": row[16] or "",
                "첫 줄": lines}

    @app.post("/api/audio/start")
    async def audio_begin(request: Request):
        """Start an audio batch from the dashboard.

        @param {Request} request - Carries `{"곡": 100, "동시": 3, "고르기만": false}`.
        @returns {dict} Whether it started.
        """
        asked = await request.json()
        began = audio_start(int(asked.get("곡") or 100), int(asked.get("동시") or 3),
                            bool(asked.get("고르기만")))
        return {"시작": began}

    @app.post("/api/audio/stop")
    def audio_halt():
        """Stop the audio batch after the songs already in flight.

        @returns {dict} Confirmation.
        """
        _audio_halt.set()
        return {"멈춤": True}

    @app.post("/api/audio/choose")
    async def audio_choose(request: Request):
        """Fetch a different candidate for one song, chosen by a person.

        @param {Request} request - Carries `{"번호": 123, "영상": "abc"}`.
        @returns {dict} Confirmation; the result arrives on the stream.
        """
        asked = await request.json()
        track_id, video_id = int(asked["번호"]), str(asked["영상"])

        def go() -> None:
            result = fetch_audio.choose(AUDIO_BOOK, AUDIO_OUT, track_id, video_id)
            push({"kind": "audio-song", **result, "run": dict(AUDIO_RUN)})

        threading.Thread(target=go, daemon=True).start()
        return {"받는 중": True}

    @app.post("/api/audio/mark")
    async def audio_mark(request: Request):
        """Mark a song's pick as wrong, or put it back to be searched again.

        @param {Request} request - Carries `{"번호": 123, "상태": "wrong"}` or `{"번호": 123, "상태": "again"}`.
        @returns {dict} The new state.
        """
        asked = await request.json()
        track_id, state = int(asked["번호"]), str(asked["상태"])
        book = fetch_audio.open_book(AUDIO_BOOK)
        if state == "again":
            book.execute("DELETE FROM audio WHERE track_id=?", (track_id,))
        else:
            book.execute("UPDATE audio SET state=?, tried_at=datetime('now') WHERE track_id=?",
                         (state, track_id))
        book.commit()
        book.close()
        return {"번호": track_id, "상태": state}

    @app.get("/media/{track_id}")
    def media(track_id: int):
        """Serve a downloaded song so the dashboard can play it.

        @param {int} track_id - Which song.
        @returns {FileResponse} The audio file.
        """
        from fastapi import HTTPException
        path = os.path.join(AUDIO_OUT, f"{track_id}.m4a")
        if not os.path.exists(path):
            raise HTTPException(404, "받은 음원이 없다")
        return FileResponse(path, media_type="audio/mp4")

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
