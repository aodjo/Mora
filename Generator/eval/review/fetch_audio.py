#!/usr/bin/env python3
"""**바이브 곡의 음원을 유튜브에서 제대로 찾아 받는다.** 줄 시각은 바이브의 그 트랙(그 앨범판)에
맞춰진 것이라, 같은 제목의 아무 영상이 아니라 **같은 녹음**을 찾아야 한다.

유튜브에서 「김광석 사랑이라는 이유로」를 찾으면 공식 채널에만 같은 제목이 234·236·226·282·214·
297·228 초로 일곱 판이 있다(다른 녹음·리마스터·실황). 거기에 노래방, 1 시간 반복, 공연 실황, 커버가
섞인다. 바이브의 그 트랙은 225 초이고, 맞는 것은 226 초 하나다. Ne-Yo 「Because Of You」는 바이브
266 초 — 공식 채널의 제목만 있는 업로드가 267 초이고, 뮤직비디오는 237 초라 걸러진다.

그래서 **길이가 관문이다.** 바이브가 준 길이와 `LENGTH_GATE` 초 안인 후보만 남기고, 남은 것을 점수로
고른다:

  * 길이가 가까울수록 (1 초 안이면 가장 높다)
  * 제목이 곡 제목과 똑같으면 — 앨범 음원 업로드는 제목만 달랑 있다
  * 「- Topic」 채널(유튜브가 음반사 음원을 자동으로 올리는 곳), 인증 채널, 「Official Audio」
  * 곡 제목·앨범에 없는 금지어(라이브·커버·리믹스·노래방·반복·빠르게…)가 제목에 있으면 크게 깎는다

검색은 두 번 한다. 「아티스트 제목」과 「아티스트 제목 topic」 — 뒤의 것이 제목만 있는 앨범 음원
업로드를 끌어온다. 받은 뒤에는 파일의 실제 길이를 다시 재서 바이브와 `FILE_GATE` 초 넘게 다르면
「의심」으로 표시한다.

소리의 내용으로 맞는 곡인지까지 가르는 검사(받아쓰기 ↔ 가사)는 GPU 가 있는 쪽에서 따로 한다.
여기서는 받을 곡을 고르고 받는 데까지다.

@example
  python fetch_audio.py --limit 30 --dry            # 받지 않고 무엇을 고르는지만 본다
  python fetch_audio.py --limit 500 --hands 3        # 곡 500 개를 받는다
"""
import argparse
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor

#: 바이브 길이와 이만큼(초) 안인 후보만 본다. 같은 녹음의 다른 업로드는 1~2 초 안에 든다.
LENGTH_GATE = 4
#: 받은 파일의 실제 길이가 바이브와 이만큼(초) 넘게 다르면 의심으로 표시한다.
FILE_GATE = 3
#: 이 점수 아래면 받지 않고 「못 찾음」으로 남긴다.
LEAST_SCORE = 45
#: 한 번에 가져오는 검색 결과 수.
SEARCH_MANY = 12
#: 검색·받기 사이의 쉼(초). 유튜브에 막히면 다 끝이다.
REST = 1.5
#: 남은 디스크가 이만큼(GB) 밑이면 판을 멈춘다. 128kbps 로 전부 받으면 5,680 시간에 330GB 쯤이다.
LEAST_FREE_GB = float(os.environ.get("MORA_AUDIO_FLOOR_GB", "40"))
#: 받은 파일이 가질 수 있는 끝. 다시 인코딩하지 않으니 유튜브가 준 그릇 그대로다.
TAILS = (".m4a", ".webm", ".opus", ".ogg", ".mp3")
#: yt-dlp 오류에 이 말이 있으면 곡 탓이 아니라 유튜브가 막았거나 망이 끊긴 것이다. 소문자로 비교한다.
BLOCK_SIGNS = ("sign in to confirm", "not a bot", "http error 429", "too many requests", "getaddrinfo",
               "name resolution", "network is unreachable", "timed out", "connection reset",
               "connection refused", "remote end closed")
#: 막히면 이만큼(초) 쉬고 그 곡을 한 번 더 해 본다. 또 막히면 판을 멈춘다.
BLOCK_WAIT = 90


class Blocked(Exception):
    """YouTube refused, or the network dropped — nothing is known about the song itself.

    Kept apart from an empty search so that a block halfway through a long batch stops it
    instead of writing thousands of songs down as not found, which no later batch would revisit.
    """

#: 곡 제목이나 앨범에 없는데 영상 제목에 있으면 다른 녹음이라는 표시. 소문자로 비교한다.
WRONG = [
    "live", "라이브", "cover", "커버", "remix", "리믹스", "inst", "instrumental", " mr", "mr ",
    "karaoke", "노래방", "tj노래방", "금영", "1시간", "1 hour", "hour", "loop", "반복", "sped up",
    "speed up", "slowed", "reverb", "nightcore", "8d", "교차편집", "무대", "stage", "직캠", "fancam",
    "teaser", "reaction", "반응", "piano", "피아노", "acoustic", "어쿠스틱", "guitar", "기타",
    "performance", "dance", "안무", "choreography", "concert", "콘서트", "full album", "playlist",
    "플레이리스트", "모음", "medley", "메들리", "mashup", "parody", "패러디", "shorts",
]


def plain(text: str) -> str:
    """Fold a title to letters and digits only, lowercase, for comparing across sources.

    @param {str} text - A title or a name.
    @returns {str} The same text with case, width, spacing and punctuation folded away.
    """
    text = unicodedata.normalize("NFKC", text or "").lower()
    return "".join(one for one in text if one.isalnum())


def core_title(title: str) -> str:
    """The title without bracketed tails such as `(Feat. …)` or `[Remastered]`.

    @param {str} title - Vibe's track title.
    @returns {str} The core part, folded with `plain`.
    """
    return plain(re.sub(r"[\(\[\{（【].*?[\)\]\}）】]", " ", title or "")) or plain(title)


def first_artist(artist: str) -> str:
    """The first name on a credit line like `Kenny G, Chaka Khan`.

    @param {str} artist - Vibe's artist string.
    @returns {str} The first artist.
    """
    return (artist or "").split(",")[0].strip()


def score(want: dict, one: dict) -> tuple[float, str]:
    """Score one search result against the Vibe track it is meant to be.

    @param {dict} want - The Vibe track: `title`, `artist`, `album`, `duration`.
    @param {dict} one - A search result: `title`, `channel`, `duration`, `channel_is_verified`.
    @returns {tuple[float, str]} The score (−1 when it fails the length gate) and why.
    """
    got = float(one.get("duration") or 0)
    miss = abs(got - float(want["duration"] or 0))
    if not got or miss > LENGTH_GATE:
        return -1.0, f"길이 {got:.0f}s"
    why = [f"±{miss:.0f}s"]
    total = {0: 40, 1: 40, 2: 30, 3: 15}.get(int(round(miss)), 5)

    title = unicodedata.normalize("NFKC", one.get("title") or "").lower()
    flat = plain(title)
    mine = core_title(want["title"])
    if flat == mine or flat == plain(want["title"]):
        total += 25
        why.append("제목만")
    elif mine and mine in flat:
        total += 15
        why.append("제목")
    else:
        common = sum(1 for letter in set(mine) if letter in flat) / max(1, len(set(mine)))
        total += 15 * common
        why.append(f"제목 {common:.0%}")

    channel = one.get("channel") or one.get("uploader") or ""
    if channel.endswith(" - Topic"):
        total += 25
        why.append("Topic")
    if one.get("channel_is_verified"):
        total += 10
        why.append("인증")
    if "official audio" in title or "(audio)" in title or "[audio]" in title:
        total += 10
        why.append("audio")
    who = plain(first_artist(want["artist"]))
    if who and (who in flat or who in plain(channel)):
        total += 10
        why.append("가수")

    allowed = (want["title"] + " " + (want.get("album") or "")).lower()
    for word in WRONG:
        if word in title and word.strip() not in allowed:
            total -= 40
            why.append(f"✗{word.strip()}")
            break
    return total, " ".join(why)


def last_error(said: str) -> str:
    """The last `ERROR:` line yt-dlp wrote, which is the one that says why it stopped.

    @param {str} said - yt-dlp's stderr.
    @returns {str} That line without its prefix, or an empty string.
    """
    lines = [line for line in (said or "").splitlines() if line.startswith("ERROR:")]
    return lines[-1][len("ERROR:"):].strip() if lines else ""


def search(binary: str, query: str) -> list[dict]:
    """Ask YouTube for candidates without downloading anything.

    @param {str} binary - Path to `yt-dlp`.
    @param {str} query - The search words.
    @returns {list[dict]} Results with id, title, channel, duration and verification.
    @throws {Blocked} When yt-dlp fails without returning anything — an empty search exits cleanly.
    """
    try:
        got = subprocess.run(
            [binary, "--flat-playlist", "--skip-download", "--dump-json", "--no-warnings",
             f"ytsearch{SEARCH_MANY}:{query}"],
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired as late:
        raise Blocked("검색 시간 초과") from late
    if got.returncode != 0 and not got.stdout.strip():
        raise Blocked(last_error(got.stderr) or f"yt-dlp 끝남 {got.returncode}")
    out = []
    for line in got.stdout.splitlines():
        try:
            item = json.loads(line)
        except ValueError:
            continue
        out.append({"id": item.get("id"), "title": item.get("title") or "",
                    "channel": item.get("channel") or item.get("uploader") or "",
                    "duration": item.get("duration") or 0,
                    "channel_is_verified": bool(item.get("channel_is_verified"))})
    return out


def pick(binary: str, want: dict) -> dict:
    """Find the upload that is the same recording as the Vibe track.

    Searches `artist title` first and `artist title topic` second, stopping early when the
    first search already holds a near-certain match (a bare-titled upload within a second).

    @param {str} binary - Path to `yt-dlp`.
    @param {dict} want - The Vibe track.
    @returns {dict} The chosen candidate with its score and reason, or `{"없음": ...}` with the best tries.
    """
    who = first_artist(want["artist"])
    seen: dict[str, dict] = {}
    for query in (f"{who} {want['title']}", f"{who} {want['title']} topic"):
        for one in search(binary, query):
            if one["id"] and one["id"] not in seen:
                one["점수"], one["까닭"] = score(want, one)
                seen[one["id"]] = one
        best = max(seen.values(), key=lambda one: one["점수"], default=None)
        if best and best["점수"] >= LEAST_SCORE + 30:
            break
        time.sleep(REST)
    ranked = sorted(seen.values(), key=lambda one: one["점수"], reverse=True)
    if ranked and ranked[0]["점수"] >= LEAST_SCORE:
        return {**ranked[0], "후보": ranked[:5]}
    return {"없음": True, "후보": ranked[:5]}


def file_of(out_dir: str, name: str) -> str | None:
    """Find a song's downloaded file, whatever container YouTube gave it in.

    @param {str} out_dir - Where downloads go.
    @param {str} name - File name without extension (the Vibe track id).
    @returns {str | None} The path, or None when there is none.
    """
    for tail in TAILS:
        path = os.path.join(out_dir, f"{name}{tail}")
        if os.path.exists(path):
            return path
    return None


def fetch(binary: str, video_id: str, out_dir: str, name: str) -> str | None:
    """Download one upload's audio stream as YouTube serves it, without re-encoding.

    Asking yt-dlp for m4a at the best quality re-encoded every stream to AAC at about 400 kbps —
    three times the size of the 128 kbps AAC YouTube already serves, and a second lossy pass on
    top. The native AAC stream is taken as is; when an upload has none, its Opus stream is kept in
    its own container.

    @param {str} binary - Path to `yt-dlp`.
    @param {str} video_id - Which upload.
    @param {str} out_dir - Where to put it.
    @param {str} name - File name without extension (the Vibe track id).
    @returns {str | None} The file path, or None when the upload itself would not come (removed, private).
    @throws {Blocked} When the failure is YouTube refusing or the network, not the upload.
    """
    try:
        got = subprocess.run(
            [binary, "--no-playlist", "--retries", "5", "-f", "bestaudio[ext=m4a]/bestaudio",
             "--no-warnings", "-o", os.path.join(out_dir, f"{name}.%(ext)s"),
             f"https://www.youtube.com/watch?v={video_id}"],
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired as late:
        raise Blocked("받기 시간 초과") from late
    path = file_of(out_dir, name)
    if not path and any(sign in (got.stderr or "").lower() for sign in BLOCK_SIGNS):
        raise Blocked(last_error(got.stderr) or "받기 막힘")
    return path


def disk_left(out_dir: str) -> float:
    """How much room is left where downloads go.

    @param {str} out_dir - Where downloads go.
    @returns {float} Free space in GB.
    """
    return shutil.disk_usage(out_dir).free / 1e9


def length_of(path: str) -> float:
    """Read a file's real length with ffprobe.

    @param {str} path - The audio file.
    @returns {float} Seconds, or 0.0 when it cannot be read.
    """
    probe = shutil.which("ffprobe")
    if not probe:
        return 0.0
    got = subprocess.run([probe, "-v", "error", "-show_entries", "format=duration", "-of",
                          "default=nw=1:nk=1", path], capture_output=True, text=True, timeout=60)
    try:
        return float(got.stdout.strip())
    except ValueError:
        return 0.0


def width(text: str) -> int:
    """How many terminal columns a string takes — Hangul and other wide letters take two.

    @param {str} text - Any text.
    @returns {int} Its display width.
    """
    return sum(2 if unicodedata.east_asian_width(one) in ("W", "F") else 1 for one in text)


def fit(text: str, room: int) -> str:
    """Cut or pad a string to exactly `room` columns, so columns line up in the terminal.

    @param {str} text - Any text.
    @param {int} room - Columns to fill.
    @returns {str} The text, cut with `…` or padded with spaces.
    """
    text = (text or "").replace("\n", " ")
    if width(text) > room:
        out, used = "", 0
        for one in text:
            step = width(one)
            if used + step > room - 1:
                break
            out += one
            used += step
        text = out + "…"
    return text + " " * max(0, room - width(text))


class Board:
    """The terminal display: one tidy pair of lines per song above a tqdm bar at the bottom.

    Several songs are worked on at once, so lines arrive out of order; each song's lines go out
    whole through `tqdm.write`, which lifts the bar, prints above it and puts it back. The tallies
    (고름·받음·못 찾음…) ride on the bar as its postfix.
    """

    def __init__(self, total: int):
        """Start a board for `total` songs.

        @param {int} total - How many songs this run will handle.
        """
        from tqdm import tqdm
        self.write = tqdm.write
        self.count: dict[str, int] = {}
        self.lock = threading.Lock()
        self.bar = tqdm(total=total, unit="곡", dynamic_ncols=True, leave=True,
                        bar_format="  {bar:28} {n_fmt}/{total_fmt} {percentage:3.0f}%"
                                   "  {desc}  [{elapsed} 지남 · {remaining} 남음]")

    def say(self, lines: list[str], kind: str) -> None:
        """Print one song's lines above the bar and move it on.

        @param {list[str]} lines - What to print for this song.
        @param {str} kind - Which tally this song counts under.
        @returns {None}
        """
        with self.lock:
            self.count[kind] = self.count.get(kind, 0) + 1
            self.write("\n".join(lines))
            self.bar.set_description_str(
                " · ".join(f"{key} {value}" for key, value in self.count.items()), refresh=False)
            self.bar.update(1)

    def end(self) -> None:
        """Close the bar, leaving it in place.

        @returns {None}
        """
        self.bar.close()


def open_book(where: str) -> sqlite3.Connection:
    """Open the record of what was searched and fetched, kept apart from the lyric store.

    The lyric store belongs to the harvest; this side only reads it, so the two never write to
    the same file. Artist and title are copied in so the dashboard can list the record without
    reaching across into the other store.

    @param {str} where - Path to the audio record.
    @returns {sqlite3.Connection} The connection.
    """
    conn = sqlite3.connect(where, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=10000")
    conn.execute("""CREATE TABLE IF NOT EXISTS audio (
        track_id INTEGER PRIMARY KEY, state TEXT, video_id TEXT, video_title TEXT,
        channel TEXT, video_duration REAL, want_duration REAL, score REAL, why TEXT,
        file TEXT, file_duration REAL, tried_at TEXT, candidates TEXT)""")
    had = {one[1] for one in conn.execute("PRAGMA table_info(audio)")}
    for column, kind in (("artist", "TEXT"), ("title", "TEXT"), ("album", "TEXT"),
                         ("manual", "INTEGER DEFAULT 0")):
        if column not in had:
            conn.execute(f"ALTER TABLE audio ADD COLUMN {column} {kind}")
    conn.execute("CREATE INDEX IF NOT EXISTS audio_state ON audio(state)")
    conn.commit()
    return conn


def worklist(vibe: str, book: sqlite3.Connection, limit: int, dry: bool = False) -> list[dict]:
    """Choose which songs to handle next.

    When fetching for real, songs already chosen but not yet downloaded come first — a dry run
    picks, a person looks the picks over on the dashboard, and the real run then downloads what
    stands without searching again. After them come songs never tried, spread across artists:
    each artist's song with the most lines first, then everyone's second song, and so on, so a
    batch of five hundred covers five hundred artists instead of a few prolific ones.

    @param {str} vibe - Path to the lyric store (read only).
    @param {sqlite3.Connection} book - The audio record.
    @param {int} limit - How many to return.
    @param {bool} [dry=False] - A choosing-only run; then already-chosen songs are not revisited.
    @returns {list[dict]} Songs to handle, some carrying a `chosen` upload already.
    """
    out: list[dict] = []
    if not dry:
        for one in book.execute(
                "SELECT track_id, title, artist, album, want_duration, video_id, video_title,"
                " channel, video_duration, score, why, candidates FROM audio WHERE state='picked'"
                " LIMIT ?", (limit,)):
            out.append({"track_id": one[0], "title": one[1] or "", "artist": one[2] or "",
                        "album": one[3] or "", "duration": one[4] or 0,
                        "chosen": {"id": one[5], "title": one[6], "channel": one[7],
                                   "duration": one[8], "점수": one[9], "까닭": one[10],
                                   "후보": json.loads(one[11] or "[]")}})
    done = {one[0] for one in book.execute("SELECT track_id FROM audio")}
    conn = sqlite3.connect(f"file:{vibe}?mode=ro", uri=True)
    rows = conn.execute("""
        SELECT track_id, title, artist, album, duration FROM (
          SELECT track_id, title, artist, album, duration, line_count,
            ROW_NUMBER() OVER (PARTITION BY lower(trim(artist)) ORDER BY line_count DESC) AS nth
          FROM tracks WHERE state='synced' AND duration > 0
        ) ORDER BY nth, (track_id * 2654435761) % 4294967296""").fetchall()
    conn.close()
    for one in rows:
        if len(out) >= limit:
            break
        if one[0] in done:
            continue
        out.append({"track_id": one[0], "title": one[1], "artist": one[2], "album": one[3],
                    "duration": one[4]})
    return out


def settle(binary: str, want: dict, out_dir: str, dry: bool) -> dict:
    """Handle one song: choose an upload (unless one is already chosen) and, unless dry, fetch it.

    @param {str} binary - Path to `yt-dlp`.
    @param {dict} want - The Vibe track, possibly carrying a `chosen` upload.
    @param {str} out_dir - Where downloads go.
    @param {bool} dry - Choose only.
    @returns {dict} What happened, in the shape the dashboard and the terminal both read.
    """
    chosen = want.get("chosen") or pick(binary, want)
    result = {"track_id": want["track_id"], "artist": want["artist"], "title": want["title"],
              "album": want.get("album") or "", "want": want["duration"],
              "candidates": [{key: one.get(key) for key in ("id", "title", "channel", "duration", "점수", "까닭")}
                             for one in chosen.get("후보", [])],
              "file": None, "real": 0.0, "manual": bool(want.get("manual"))}
    if chosen.get("없음"):
        return {**result, "state": "miss", "video": None, "score": None, "why": ""}
    result.update({"video": {key: chosen.get(key) for key in ("id", "title", "channel", "duration")},
                   "score": chosen.get("점수"), "why": chosen.get("까닭") or ""})
    if dry:
        return {**result, "state": "picked"}
    path = fetch(binary, chosen["id"], out_dir, str(want["track_id"]))
    real = length_of(path) if path else 0.0
    if not path:
        state = "fail"
    elif real and abs(real - float(want["duration"] or 0)) > FILE_GATE:
        state = "suspect"
    else:
        state = "got"
    time.sleep(REST)
    return {**result, "state": state, "file": path, "real": real}


def record(book: sqlite3.Connection, lock: threading.Lock, result: dict) -> None:
    """Write one song's outcome into the audio record.

    @param {sqlite3.Connection} book - The audio record.
    @param {threading.Lock} lock - Guards writes.
    @param {dict} result - What `settle` returned.
    @returns {None}
    """
    video = result.get("video") or {}
    with lock:
        book.execute(
            "INSERT OR REPLACE INTO audio (track_id, state, video_id, video_title, channel,"
            " video_duration, want_duration, score, why, file, file_duration, tried_at,"
            " candidates, artist, title, album, manual)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?,?,?,?,?)",
            (result["track_id"], result["state"], video.get("id"), video.get("title"),
             video.get("channel"), video.get("duration"), result["want"], result.get("score"),
             result.get("why"), result.get("file"), result.get("real"),
             json.dumps(result.get("candidates") or [], ensure_ascii=False),
             result["artist"], result["title"], result.get("album"), 1 if result.get("manual") else 0))
        book.commit()


def yt_binary() -> str:
    """Find `yt-dlp`: on PATH, or beside the running Python.

    @returns {str} Path to the executable.
    """
    return shutil.which("yt-dlp") or os.path.join(os.path.dirname(sys.executable), "yt-dlp")


def run(vibe: str, book_path: str, out_dir: str, limit: int, hands: int, dry: bool,
        watch=None, halt: threading.Event | None = None) -> dict:
    """Handle the next batch of songs, reporting each as it finishes.

    Shared by the terminal and the dashboard: each finished song goes to `watch`, and `halt`
    stops the batch after the songs already in flight. A fetching batch also stops itself when
    the disk falls below `LEAST_FREE_GB`, telling `watch` once with a `full` event, and when
    YouTube blocks twice in a row on the same song, telling it once with a `blocked` event. A
    blocked song is not written down, so the next batch takes it again.

    @param {str} vibe - Path to the lyric store (read only).
    @param {str} book_path - Path to the audio record.
    @param {str} out_dir - Where downloads go.
    @param {int} limit - How many songs.
    @param {int} hands - How many at once.
    @param {bool} dry - Choose only, fetch nothing.
    @param {callable | None} [watch=None] - Called with each song's result, and once with the total at the start.
    @param {threading.Event | None} [halt=None] - Set to stop early.
    @returns {dict} How many songs ended in each state.
    """
    binary = yt_binary()
    os.makedirs(out_dir, exist_ok=True)
    book = open_book(book_path)
    lock = threading.Lock()
    stop = halt if halt is not None else threading.Event()
    todo = worklist(vibe, book, limit, dry)
    tally: dict[str, int] = {}
    if watch:
        watch({"kind": "start", "total": len(todo), "dry": dry})

    def one(want: dict) -> None:
        if stop.is_set():
            return
        if not dry and disk_left(out_dir) < LEAST_FREE_GB:
            with lock:
                first = not stop.is_set()
                stop.set()
            if first and watch:
                watch({"kind": "full", "free": round(disk_left(out_dir), 1), "floor": LEAST_FREE_GB})
            return
        for attempt in (1, 2):
            try:
                result = settle(binary, want, out_dir, dry)
                break
            except Blocked as trouble:
                if attempt == 1:
                    if stop.wait(BLOCK_WAIT):
                        return
                    continue
                with lock:
                    first = not stop.is_set()
                    stop.set()
                if first and watch:
                    watch({"kind": "blocked", "why": str(trouble)})
                return
            except Exception as trouble:  # noqa: BLE001
                result = {"track_id": want["track_id"], "artist": want["artist"], "title": want["title"],
                          "album": want.get("album") or "", "want": want["duration"], "state": "fail",
                          "video": None, "score": None, "why": f"{type(trouble).__name__}",
                          "candidates": [], "file": None, "real": 0.0}
                break
        record(book, lock, result)
        with lock:
            tally[result["state"]] = tally.get(result["state"], 0) + 1
        if watch:
            watch({"kind": "song", **result})

    with ThreadPoolExecutor(max_workers=max(1, hands)) as pool:
        list(pool.map(one, todo))
    book.close()
    return tally


def choose(vibe_book: str, out_dir: str, track_id: int, video_id: str) -> dict:
    """Fetch a different upload for one song, chosen by a person on the dashboard.

    @param {str} vibe_book - Path to the audio record.
    @param {str} out_dir - Where downloads go.
    @param {int} track_id - Which song.
    @param {str} video_id - The upload to fetch instead.
    @returns {dict} The new outcome.
    """
    book = open_book(vibe_book)
    row = book.execute("SELECT title, artist, album, want_duration, candidates FROM audio WHERE track_id=?",
                       (track_id,)).fetchone()
    if not row:
        book.close()
        return {"없음": True}
    candidates = json.loads(row[4] or "[]")
    picked = next((one for one in candidates if one.get("id") == video_id),
                  {"id": video_id, "title": "", "channel": "", "duration": row[3], "점수": None, "까닭": "사람이 고름"})
    want = {"track_id": track_id, "title": row[0], "artist": row[1], "album": row[2],
            "duration": row[3], "manual": True,
            "chosen": {**picked, "까닭": (picked.get("까닭") or "") + " · 사람이 고름", "후보": candidates}}
    old = file_of(out_dir, str(track_id))
    aside = old + ".old" if old else None
    if old:
        os.replace(old, aside)
    try:
        result = settle(yt_binary(), want, out_dir, dry=False)
    except Blocked:
        if aside:
            os.replace(aside, old)
        book.close()
        raise
    if aside and os.path.exists(aside):
        os.remove(aside)
    record(book, threading.Lock(), result)
    book.close()
    return result


def lines_for(result: dict) -> tuple[list[str], str]:
    """The terminal's two lines for one song, and which tally it counts under.

    @param {dict} result - What `settle` returned.
    @returns {tuple[list[str], str]} The lines and the tally label.
    """
    song = fit(f"{first_artist(result['artist'])} — {result['title']}", 44)
    if result["state"] == "miss":
        top = (result.get("candidates") or [{}])[0]
        second = (f"             가장 가까운 것: {top.get('duration') or 0:.0f}s "
                  f"{fit(top.get('title') or '', 40)} [{top.get('까닭') or ''}]" if top else
                  "             검색 결과 없음")
        return [f"  ✗ 못 찾음  {song} {result['want']:>4.0f}s", second], "못 찾음"
    marks = {"picked": ("✓ 고름  ", "고름"), "got": ("✓ 받음  ", "받음"),
             "suspect": ("⚠ 의심  ", "의심"), "fail": ("✗ 실패  ", "실패")}
    mark, kind = marks.get(result["state"], ("·", result["state"]))
    video = result.get("video") or {}
    got_len = f"{video.get('duration') or 0:.0f}s" + (f" (파일 {result['real']:.0f}s)" if result.get("real") else "")
    return [f"  {mark}  {song} {result['want']:>4.0f}s → {got_len}  "
            f"{result.get('score') or 0:>3.0f}점  {result.get('why') or ''}",
            f"             https://youtu.be/{video.get('id')}  "
            f"{fit(video.get('channel') or '', 22)} {fit(video.get('title') or '', 48).rstrip()}"], kind


def main() -> int:
    """Search, choose, and (unless `--dry`) fetch audio for the next batch of songs, in the terminal.

    @returns {int} 0 always.
    """
    ask = argparse.ArgumentParser(description="바이브 곡의 음원을 유튜브에서 찾아 받는다")
    ask.add_argument("--vibe", default="vibe.db", help="가사 장부 (읽기만 한다)")
    ask.add_argument("--book", default="audio.db", help="찾고 받은 기록")
    ask.add_argument("--out", default="vibe_audio", help="음원을 둘 곳")
    ask.add_argument("--limit", type=int, default=50, help="이번에 다룰 곡 수")
    ask.add_argument("--hands", type=int, default=3, help="동시에 받는 수")
    ask.add_argument("--dry", action="store_true", help="받지 않고 고르기만 (고른 것은 기록되고, 다음 받기가 그대로 받는다)")
    args = ask.parse_args()
    board: dict = {}

    def watch(event: dict) -> None:
        if event["kind"] == "start":
            print(f"\n  곡 {event['total']} · {'고르기만 (받지 않음)' if args.dry else '찾아서 받기'}"
                  f" · 동시에 {args.hands}\n", flush=True)
            board["it"] = Board(event["total"])
            return
        if event["kind"] == "full":
            board["it"].write(f"  ■ 남은 디스크 {event['free']}GB — 바닥선 {event['floor']:.0f}GB 밑이라 멈춘다"
                              f" (MORA_AUDIO_FLOOR_GB 로 바꾼다)")
            return
        if event["kind"] == "blocked":
            board["it"].write(f"  ■ 유튜브가 막았거나 망이 끊겼다 — 멈춘다. 막힌 곡은 안 적었으니 다음 판이 다시 한다."
                              f"  ({fit(event['why'], 80).rstrip()})")
            return
        lines, kind = lines_for(event)
        board["it"].say(lines, kind)

    run(args.vibe, args.book, args.out, args.limit, args.hands, args.dry, watch=watch)
    if "it" in board:
        board["it"].end()
    print(f"  기록: {args.book} · 음원: {args.out}/", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
