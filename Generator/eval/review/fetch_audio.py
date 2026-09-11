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
        return -1.0, f"길이 {got:.0f}s (바이브 {want['duration']:.0f}s)"
    why = [f"길이 차 {miss:.0f}s"]
    total = {0: 40, 1: 40, 2: 30, 3: 15}.get(int(round(miss)), 5)

    title = unicodedata.normalize("NFKC", one.get("title") or "").lower()
    flat = plain(title)
    mine = core_title(want["title"])
    if flat == mine or flat == plain(want["title"]):
        total += 25
        why.append("제목만 있음")
    elif mine and mine in flat:
        total += 15
        why.append("제목 들어 있음")
    else:
        common = sum(1 for letter in set(mine) if letter in flat) / max(1, len(set(mine)))
        total += 15 * common
        why.append(f"제목 닮음 {common:.0%}")

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
        why.append("아티스트")

    allowed = (want["title"] + " " + (want.get("album") or "")).lower()
    for word in WRONG:
        if word in title and word.strip() not in allowed:
            total -= 40
            why.append(f"금지어 {word.strip()}")
            break
    return total, " · ".join(why)


def search(binary: str, query: str) -> list[dict]:
    """Ask YouTube for candidates without downloading anything.

    @param {str} binary - Path to `yt-dlp`.
    @param {str} query - The search words.
    @returns {list[dict]} Results with id, title, channel, duration and verification.
    """
    got = subprocess.run(
        [binary, "--flat-playlist", "--skip-download", "--dump-json", "--no-warnings",
         f"ytsearch{SEARCH_MANY}:{query}"],
        stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120)
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


def fetch(binary: str, video_id: str, out_dir: str, name: str) -> str | None:
    """Download one upload's best audio as m4a.

    @param {str} binary - Path to `yt-dlp`.
    @param {str} video_id - Which upload.
    @param {str} out_dir - Where to put it.
    @param {str} name - File name without extension (the Vibe track id).
    @returns {str | None} The file path, or None when nothing arrived.
    """
    subprocess.run(
        [binary, "--no-playlist", "--retries", "5", "-f", "bestaudio/best", "-x",
         "--audio-format", "m4a", "--audio-quality", "0", "--no-warnings",
         "-o", os.path.join(out_dir, f"{name}.%(ext)s"),
         f"https://www.youtube.com/watch?v={video_id}"],
        stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=900)
    path = os.path.join(out_dir, f"{name}.m4a")
    return path if os.path.exists(path) else None


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


def open_book(where: str) -> sqlite3.Connection:
    """Open the record of what was searched and fetched, kept apart from the lyric store.

    The lyric store belongs to the harvest on the other machine; this side only reads it, so
    the two never write to the same file.

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
    conn.commit()
    return conn


def worklist(vibe: str, book: sqlite3.Connection, limit: int) -> list[dict]:
    """Choose which songs to fetch next, spread across artists.

    One song per artist first — each artist's song with the most lines — then everyone's second
    song, and so on. A first batch of five hundred then covers five hundred artists instead of a
    few prolific ones.

    @param {str} vibe - Path to the lyric store (read only).
    @param {sqlite3.Connection} book - The audio record, to skip what was already tried.
    @param {int} limit - How many to return.
    @returns {list[dict]} Tracks to fetch.
    """
    done = {one[0] for one in book.execute("SELECT track_id FROM audio")}
    conn = sqlite3.connect(f"file:{vibe}?mode=ro", uri=True)
    rows = conn.execute("""
        SELECT track_id, title, artist, album, duration FROM (
          SELECT track_id, title, artist, album, duration, line_count,
            ROW_NUMBER() OVER (PARTITION BY lower(trim(artist)) ORDER BY line_count DESC) AS nth
          FROM tracks WHERE state='synced' AND duration > 0
        ) ORDER BY nth, (track_id * 2654435761) % 4294967296""").fetchall()
    conn.close()
    out = []
    for one in rows:
        if one[0] in done:
            continue
        out.append({"track_id": one[0], "title": one[1], "artist": one[2], "album": one[3],
                    "duration": one[4]})
        if len(out) >= limit:
            break
    return out


def main() -> int:
    """Search, choose, and (unless `--dry`) fetch audio for the next batch of songs.

    @returns {int} 0 always.
    """
    ask = argparse.ArgumentParser(description="바이브 곡의 음원을 유튜브에서 찾아 받는다")
    ask.add_argument("--vibe", default="vibe.db", help="가사 장부 (읽기만 한다)")
    ask.add_argument("--book", default="audio.db", help="찾고 받은 기록")
    ask.add_argument("--out", default="vibe_audio", help="음원을 둘 곳")
    ask.add_argument("--limit", type=int, default=50, help="이번에 다룰 곡 수")
    ask.add_argument("--hands", type=int, default=3, help="동시에 받는 수")
    ask.add_argument("--dry", action="store_true", help="받지 않고 고르기만")
    args = ask.parse_args()

    binary = shutil.which("yt-dlp") or os.path.join(os.path.dirname(sys.executable), "yt-dlp")
    os.makedirs(args.out, exist_ok=True)
    book = open_book(args.book)
    lock = threading.Lock()
    todo = worklist(args.vibe, book, args.limit)
    print(f"  곡 {len(todo)} · {'고르기만' if args.dry else '받기'} · 동시에 {args.hands}", flush=True)
    tally = {"받음": 0, "의심": 0, "못 찾음": 0, "실패": 0, "고름": 0}

    def one(want: dict) -> None:
        chosen = pick(binary, want)
        label = f"{want['artist'][:16]} — {want['title'][:28]} ({want['duration']:.0f}s)"
        if chosen.get("없음"):
            state = "miss"
            tally["못 찾음"] += 1
            top = chosen["후보"][0] if chosen["후보"] else {}
            print(f"  못 찾음  {label}  · 가장 나은 것 {top.get('duration', 0)}s "
                  f"{top.get('title', '')[:30]} [{top.get('까닭', '')}]", flush=True)
            path, real = None, 0.0
        else:
            print(f"  고름    {label}  → {chosen['duration']}s {chosen['channel'][:18]} · "
                  f"{chosen['title'][:34]}  [{chosen['점수']:.0f} · {chosen['까닭']}]", flush=True)
            path, real, state = None, 0.0, "picked"
            tally["고름"] += 1
            if not args.dry:
                path = fetch(binary, chosen["id"], args.out, str(want["track_id"]))
                real = length_of(path) if path else 0.0
                if not path:
                    state = "fail"
                    tally["실패"] += 1
                elif real and abs(real - want["duration"]) > FILE_GATE:
                    state = "suspect"
                    tally["의심"] += 1
                else:
                    state = "got"
                    tally["받음"] += 1
                time.sleep(REST)
        if args.dry:
            return
        with lock:
            book.execute(
                "INSERT OR REPLACE INTO audio (track_id, state, video_id, video_title, channel,"
                " video_duration, want_duration, score, why, file, file_duration, tried_at,"
                " candidates) VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?)",
                (want["track_id"], state, chosen.get("id"), chosen.get("title"),
                 chosen.get("channel"), chosen.get("duration"), want["duration"],
                 chosen.get("점수"), chosen.get("까닭"), path, real,
                 json.dumps([{k: c.get(k) for k in ("id", "title", "channel", "duration", "점수", "까닭")}
                             for c in chosen.get("후보", [])], ensure_ascii=False)))
            book.commit()

    with ThreadPoolExecutor(max_workers=max(1, args.hands)) as pool:
        list(pool.map(one, todo))
    print("\n  " + " · ".join(f"{key} {value}" for key, value in tally.items() if value), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
