#!/usr/bin/env python3
"""
한국어 정답을 귀로 검수하는 임시 도구.

`korean.py` 가 LRCLIB 에서 긁어 온 쉰다섯 곡이 정말 맞는 시각인지, 사람이 듣고 봐야 안다.
GPU 를 두 시간 돌리기 전에 자가 성한지부터 보는 것이 순서다 — 오늘 하루 잘못된 자로 세 번
속았다.

갤북에서만 돈다. Tailscale 안에서만 닿으므로 인증을 두지 않는다. 바깥으로 열 물건이 아니다.

    ~/mora-review/.venv/bin/python server.py
"""
from __future__ import annotations

import json
import re
import sqlite3
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import urllib.parse
import urllib.request

HERE = Path(__file__).parent
DB = HERE / "review.db"
AUDIO = HERE / "audio"
YTDLP = HERE.parent / "yt-dlp"  # 단일 실행파일이 없으면 venv 것을 쓴다
SEED = HERE / "korean-truth.json"
AGENT = "Mora/0.1 (https://mora.junx.dev)"

AUDIO.mkdir(exist_ok=True)
app = FastAPI(title="Mora 정답 검수")

# 내려받기는 오래 걸린다. 어느 곡이 지금 받는 중인지 여기에 둔다.
fetching: dict[str, str] = {}
fetch_lock = threading.Lock()


# ── 저장소 ────────────────────────────────────────────────────────────────────

def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def setup() -> None:
    with db() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS songs (
          id INTEGER PRIMARY KEY,
          video_id TEXT NOT NULL,
          artist TEXT NOT NULL,
          title TEXT NOT NULL,
          language TEXT NOT NULL DEFAULT 'ko',
          duration REAL NOT NULL,
          lines TEXT NOT NULL,
          -- 사람이 듣고 내린 판정. 아직 안 들은 것은 null 이다.
          verdict TEXT NULL CHECK (verdict IN ('good', 'off', 'wrong', 'drop')),
          note TEXT NOT NULL DEFAULT '',
          -- 곡 전체가 일정하게 밀렸을 때 사람이 손으로 맞춘 값(ms).
          offset_ms INTEGER NOT NULL DEFAULT 0,
          added_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS songs_video ON songs(video_id);
        """)
        # 미리 채우지 않는다. 긁어 온 쉰다섯 곡을 그대로 밀어 넣으면 검수가 "이미 있는 것을
        # 훑는 일" 이 되는데, 무엇을 넣을지 고르는 것부터가 검수다.


def row_to_song(row: sqlite3.Row, with_lines: bool = False) -> dict:
    song = {
        "id": row["id"], "video_id": row["video_id"], "artist": row["artist"],
        "title": row["title"], "language": row["language"], "duration": row["duration"],
        "verdict": row["verdict"], "note": row["note"], "offset_ms": row["offset_ms"],
        "line_count": len(json.loads(row["lines"])),
        "has_audio": bool(list(AUDIO.glob(f"{row['video_id']}.*"))),
    }
    if with_lines:
        song["lines"] = json.loads(row["lines"])
    return song


# ── 곡 ────────────────────────────────────────────────────────────────────────

@app.get("/api/songs")
def list_songs() -> list[dict]:
    with db() as conn:
        return [row_to_song(r) for r in conn.execute("SELECT * FROM songs ORDER BY artist, title")]


@app.get("/api/songs/{song_id}")
def get_song(song_id: int) -> dict:
    with db() as conn:
        row = conn.execute("SELECT * FROM songs WHERE id=?", (song_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "없는 곡")

    # 음원은 있는데 아직 안 맞춘 곡이면 **여기서 바로 건다.**
    #
    # 사람이 하는 일은 검수뿐이다. 맞추는 것은 모델의 몫이고, 사람은 그 결과가 맞는지만
    # 본다. 그러니 곡을 열었을 때 빈 화면이 나오면 안 된다 — 검수할 것이 없는 셈이다.
    got = json.loads(row["lines"])
    if audio_path(row["video_id"]) and not any(one.get("words") for one in got):
        with align_lock:
            idle = song_id not in aligning or aligning[song_id].startswith(("done", "실패"))
            if idle:
                aligning[song_id] = "보컬 뽑는 중"
        if idle:
            threading.Thread(target=run_align, args=(song_id,), daemon=True).start()
    return row_to_song(row, with_lines=True)


@app.patch("/api/songs/{song_id}")
async def edit_song(song_id: int, request: Request) -> dict:
    body = await request.json()
    fields, values = [], []
    for name in ("artist", "title", "video_id", "verdict", "note", "offset_ms"):
        if name in body:
            fields.append(f"{name}=?")
            values.append(body[name])
    if not fields:
        raise HTTPException(400, "바꿀 것이 없다")
    values.append(song_id)
    with db() as conn:
        conn.execute(f"UPDATE songs SET {', '.join(fields)} WHERE id=?", values)
        row = conn.execute("SELECT * FROM songs WHERE id=?", (song_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "없는 곡")
    return row_to_song(row, with_lines=True)


@app.put("/api/songs/{song_id}/lines")
async def save_lines(song_id: int, request: Request) -> dict:
    """줄과 그 안의 낱말을 통째로 갈아 끼운다.

    낱말 시각은 사람이 노래를 들으며 두드려 넣는다. LRCLIB 에는 사실상 없고, 우리 파이프라인
    출력으로 만들면 파이프라인의 실수를 정답으로 굳히게 된다. 한국어 낱말 정답은 이 길밖에
    없어서 손으로 만든다.
    """
    lines = await request.json()
    if not isinstance(lines, list) or not lines:
        raise HTTPException(400, "줄이 없다")
    with db() as conn:
        conn.execute("UPDATE songs SET lines=? WHERE id=?",
                     (json.dumps(lines, ensure_ascii=False), song_id))
        row = conn.execute("SELECT * FROM songs WHERE id=?", (song_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "없는 곡")
    return row_to_song(row, with_lines=True)


# 강제 정렬은 오래 걸린다(보컬 뽑기 + 갈래 가르기 + 맞추기). 어느 곡이 도는 중인지와
# **거쳐 온 자취**를 여기에 둔다.
#
# 한 줄짜리 상태로는 모자랐다. 곡 하나에 3~5 분이 걸리는데 「보컬 뽑는 중」만 떠 있으면
# 멈춘 것인지 더딘 것인지 알 수가 없고, 끝난 뒤에는 무슨 일이 있었는지 아무것도 안 남는다.
# 터미널처럼 쌓아 두면 사람이 그 자리에서 읽고 판단한다.
aligning: dict[int, str] = {}
align_log: dict[int, list[dict]] = {}
align_lock = threading.Lock()


def note(song_id: int, text: str, kind: str = "step") -> None:
    """자취 한 줄. `kind` 는 `step`(하는 중) · `done`(끝) · `bad`(실패)."""
    with align_lock:
        aligning[song_id] = text
        align_log.setdefault(song_id, []).append(
            {"at": time.time(), "text": text, "kind": kind})
        # 곡 하나에 수십 줄이면 충분하다. 더 쌓이면 앞엣것부터 버린다.
        align_log[song_id] = align_log[song_id][-60:]
NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")


def align_words(text: str) -> list[str]:
    """맞출 어절만 남긴다. 간주 표시(♫)는 부를 것이 없다."""
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def run_align(song_id: int, fresh: bool = False) -> None:
    """모델로 맞춘다. `fresh` 면 **갈래부터 다시 만든다.**

    캐시된 갈래를 그대로 쓰면 「보컬 뽑음 · 0초」가 찍힌다. 처음 거는 것이라면 맞지만,
    사람이 **「다시 맞추기」를 누른 것이라면 틀렸다** — 그건 「지금 코드로 처음부터」라는 뜻이다.
    가르는 쪽을 고쳐 놓고 옛 갈래로 맞추면 무엇을 고쳤는지 알 수가 없다.
    """
    import align as aligner
    began = time.time()
    try:
        with align_lock:
            align_log[song_id] = []
        with db() as conn:
            row = conn.execute("SELECT * FROM songs WHERE id=?", (song_id,)).fetchone()
        if row is None:
            raise RuntimeError("없는 곡")
        path = audio_path(row["video_id"])
        if path is None:
            raise RuntimeError("음원이 아직 없다")

        lines = json.loads(row["lines"])
        note(song_id, f"{row['artist']} — {row['title']} · {len(lines)}줄")
        note(song_id, f"음원 {path.name} · {path.stat().st_size / 1048576:.1f}MB")

        if fresh:
            gone = []
            for tail in MADE_FROM:
                one = AUDIO / f"{row['video_id']}{tail}"
                if one.exists():
                    one.unlink()
                    gone.append(one.name)
            note(song_id, f"옛 갈래 지움 · {len(gone)}개" if gone else "지울 옛 갈래 없음")

        step = time.time()
        note(song_id, "반주 걷는 중 (BS-Roformer)")
        voice = aligner.vocals_of(path)
        note(song_id, f"보컬 뽑음 · {time.time() - step:.0f}초 · {voice.name}")

        step = time.time()
        note(song_id, "리드·서브 목소리 가르는 중 (mel-band roformer)")
        lead, back = aligner.voices_of(path)
        note(song_id, f"갈랐음 · {time.time() - step:.0f}초 · {lead.name} · {back.name}")

        step = time.time()
        note(song_id, f"소리에 맞추는 중 (MMS_FA, {aligner.device()})")
        got, lanes = aligner.align_voices(path, lines, align_words, row["title"])
        note(song_id, f"맞췄음 · {time.time() - step:.0f}초")

        # 맞춘 줄만 갈아 끼운다. 못 맞춘 줄은 사람이 깔아 둔 것을 그대로 둔다 — 맞추기가
        # 실패한 줄을 빈칸으로 덮으면 사람이 한 일을 지우게 된다.
        next_lines = [{**line, "words": got[index], "lane": lanes.get(index, 0)}
                      if got[index] else line
                      for index, line in enumerate(lines)]
        with db() as conn:
            conn.execute("UPDATE songs SET lines=? WHERE id=?",
                         (json.dumps(next_lines, ensure_ascii=False), song_id))
        done = sum(1 for one in got if one)
        chars = sum(len(word.get("chars") or []) for line in got for word in line)
        stuck = sum(1 for line in got if line and line[0].get("stuck"))
        voices = max(lanes.values(), default=0) + 1
        note(song_id, f"글자 {chars} · 목소리 {voices}갈래 · 무너진 줄 {stuck}")
        note(song_id, f"done {done}/{len(lines)} · 통틀어 {time.time() - began:.0f}초", "done")
    except Exception as error:
        print(f"[align] {song_id} 실패: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        note(song_id, f"실패: {type(error).__name__}: {error}", "bad")


@app.post("/api/songs/{song_id}/align")
def start_align(song_id: int, fresh: bool = False) -> dict:
    """우리 모델로 맞춘다. `?fresh=1` 이면 **갈래부터 다시 만든다.**

    나온 것은 **정답이 아니라 출발점**이다. 사람이 듣고 판정해야 의미가 있다 — 이대로 두고
    「맞음」을 누르면 우리 모델의 실수가 정답이 되어 그 정답으로 우리 모델을 재게 된다.
    """
    with align_lock:
        # 「하는 중」인지 보는 데 문자열을 나열하면, 단계 이름을 하나 늘릴 때마다 여기도
        # 고쳐야 한다. 끝났음(`done`)과 실패만 아니면 도는 중이다.
        now = aligning.get(song_id, "")
        if now and not now.startswith(("done", "실패")):
            return {"state": now}
        aligning[song_id] = "보컬 뽑는 중"
    threading.Thread(target=run_align, args=(song_id, fresh), daemon=True).start()
    return {"state": "보컬 뽑는 중"}


@app.get("/api/songs/{song_id}/align")
def align_state(song_id: int) -> dict:
    with align_lock:
        return {"state": aligning.get(song_id, "없음"),
                "log": list(align_log.get(song_id, []))}


@app.delete("/api/songs/{song_id}")
def drop_song(song_id: int) -> dict:
    with db() as conn:
        conn.execute("DELETE FROM songs WHERE id=?", (song_id,))
    return {"ok": True}


@app.post("/api/songs")
async def add_song(request: Request) -> dict:
    body = await request.json()
    for need in ("video_id", "artist", "title", "duration", "lines"):
        if not body.get(need):
            raise HTTPException(400, f"{need} 가 없다")
    with db() as conn:
        cursor = conn.execute(
            "INSERT OR REPLACE INTO songs (video_id, artist, title, language, duration, lines, added_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (body["video_id"], body["artist"], body["title"], body.get("language", "ko"),
             body["duration"], json.dumps(body["lines"], ensure_ascii=False), int(time.time())))
        row = conn.execute("SELECT * FROM songs WHERE id=?", (cursor.lastrowid,)).fetchone()
    return row_to_song(row, with_lines=True)


# ── 찾기 ──────────────────────────────────────────────────────────────────────

STAMP = re.compile(r"^\[(\d{2}):(\d{2})[.:](\d{2,3})\]\s*(.*)$")


def parse_lrc(synced: str) -> list[dict]:
    rows = []
    for line in synced.splitlines():
        hit = STAMP.match(line.strip())
        if not hit or not hit.group(4).strip():
            continue
        fraction = hit.group(3)
        milli = int(fraction) * (10 if len(fraction) == 2 else 1)
        rows.append({"at": int(hit.group(1)) * 60_000 + int(hit.group(2)) * 1_000 + milli,
                     "text": hit.group(4).strip()})
    return rows


# `lyricsfile` 은 LRC 보다 낫다 — 줄의 **끝** 시각까지 준다. LRC 는 시작만 주므로 "시작은
# 맞고 끝이 틀린" 정렬을 잴 수가 없다. 이백 항목 중 백일흔여섯에 end_ms 가 있었다.
#
# 규격에는 낱말 단위(`words:`)도 있는데 이백 중 하나에만 있었고 그 하나조차 첫 줄만 차 있고
# 나머지는 `words: []` 였다. 아무도 안 채운다 — 그래서 낱말 정답은 사람이 두드려 만든다.
FILE_LINE = re.compile(
    r"^\s*-\s+text:\s*(?P<text>.*?)\s*$\n(?:(?!^\s*-\s+text:).*\n)*?"
    r"^\s+start_ms:\s*(?P<start>\d+)\s*$(?:\n^\s+end_ms:\s*(?P<end>\d+)\s*$)?",
    re.M)


def unquote(raw: str) -> str:
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        return raw[1:-1]
    return raw


def parse_lyricsfile(text: str) -> list[dict]:
    """`lyricsfile` 에서 줄의 시작·끝을 꺼낸다. YAML 파서를 들이지 않으려고 손으로 읽는다."""
    rows = []
    for hit in FILE_LINE.finditer(text):
        body = unquote(hit.group("text"))
        if not body:
            continue  # 간주 표시. 잴 것이 없다.
        row = {"at": int(hit.group("start")), "text": body}
        if hit.group("end"):
            row["end"] = int(hit.group("end"))
        rows.append(row)
    return rows


def best_lines(item: dict) -> list[dict]:
    """끝 시각이 있는 쪽을 쓴다. 없으면 LRC 로 물러선다."""
    rows = parse_lyricsfile(item.get("lyricsfile") or "")
    if rows and any("end" in row for row in rows):
        return rows
    return parse_lrc(item.get("syncedLyrics") or "")


HANGUL = re.compile(r"[가-힣]")


def artist_core(name: str) -> str:
    """표기가 갈린 같은 사람을 하나로 본다 — 「악뮤」와 「AKMU (악뮤)」는 같다."""
    hangul = "".join(HANGUL.findall(name))
    return hangul or re.sub(r"[^a-z0-9]", "", name.lower())


@app.get("/api/lrclib")
def search_lrclib(q: str = "", artist: str = "", title: str = "") -> list[dict]:
    """LRCLIB 에서 가사를 찾는다. 싱크가 있는 것만 돌려준다.

    이 API 가 받는 조합은 셋뿐이다 — 재어 보고 알았다.
      * `q=` 자유 검색. artistName·trackName·albumName 을 통째로 훑는다.
      * `track_name=` 만. 된다.
      * `track_name=` + `artist_name=`. 된다.
      * **`artist_name=` 만 주면 0 건이 온다.** 그래서 아티스트만 찾을 때는 `q=` 로 묻고
        아티스트 칸이 실제로 맞는 행만 남긴다 — 「지코」로 물으면 앨범 칸에 걸린
        `artistName="Hamah Music"` 짜리가 1 위로 오기 때문이다.
    """
    if title:
        params = {"track_name": title, **({"artist_name": artist} if artist else {})}
        keep_artist = ""
    elif artist:
        params, keep_artist = {"q": artist}, artist
    elif q:
        params, keep_artist = {"q": q}, ""
    else:
        raise HTTPException(400, "검색어가 없다")
    url = "https://lrclib.net/api/search?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"User-Agent": AGENT})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            items = json.loads(response.read().decode("utf-8"))
    except Exception as error:
        raise HTTPException(502, f"LRCLIB 에 못 닿는다: {type(error).__name__}")
    # 목록이 아닌 것이 올 때가 있다(오류 객체 등). 걸러내기 전에 먼저 확인한다 —
    # dict 를 돌면 키(문자열)를 집어 `.get` 이 없다며 500 이 난다.
    if not isinstance(items, list):
        return []
    items = [row for row in items if isinstance(row, dict)]
    if keep_artist:
        core = artist_core(keep_artist)
        items = [i for i in items if core in artist_core(i.get("artistName") or "")]
    out = []
    for item in items:
        lines = best_lines(item)
        if not lines:
            continue
        out.append({
            "artist": item.get("artistName") or "", "title": item.get("trackName") or "",
            "album": item.get("albumName") or "", "duration": float(item.get("duration") or 0),
            "lines": lines, "instrumental": str(item.get("instrumental")).lower() == "true",
            "has_end": any("end" in line for line in lines),
        })
    return out


VIBE = "https://apis.naver.com/vibeWeb/musicapiweb"
BROWSER = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
           "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def vibe_get(path: str, tries: int = 3) -> dict:
    """한 번 끊겼다고 빈손으로 돌아오지 않는다 — 네이버는 이따금 끊는다."""
    request = urllib.request.Request(
        VIBE + path,
        headers={"Referer": "https://vibe.naver.com/", "Accept": "application/json",
                 "User-Agent": BROWSER})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(request, timeout=12) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as error:
            if attempt == tries - 1:
                print(f"[vibe] {path} 못 받음: {type(error).__name__}: {error}",
                      file=sys.stderr, flush=True)
                return {}
            time.sleep(0.4 * (attempt + 1))
    return {}


def seconds(raw: object) -> float:
    """바이브의 `playTime` 은 `"04:03"` 꼴이다. 초로 바꾼다.

    LRCLIB 의 `duration` 은 초 실수라 그쪽에 맞춰 `float()` 로 읽었는데, 여기서는 그것이
    통째로 터진다. 삼킨 예외 뒤에서 여섯 곡이 조용히 사라졌다.
    """
    if isinstance(raw, (int, float)):
        return float(raw)
    text = str(raw or "").strip()
    if not text:
        return 0.0
    try:
        if ":" in text:
            parts = [float(one) for one in text.split(":")]
            total = 0.0
            for one in parts:  # 시:분:초 든 분:초 든 같은 셈으로 접힌다.
                total = total * 60 + one
            return total
        return float(text)
    except ValueError:
        return 0.0


def vibe_lines(track: dict) -> dict | None:
    """트랙 하나의 가사를 받아 우리 모양으로 바꾼다. 싱크가 없으면 버린다.

    한 곡이 넘어져도 나머지는 간다. 여섯을 함께 쏘는데 그중 하나가 예상 밖의 모양으로
    오면 `pool.map` 이 그 자리에서 다시 던져 검색 전체가 500 이 된다.
    """
    if not isinstance(track, dict):
        return None
    try:
        got = vibe_get(f"/v3/lyric/{track.get('trackId')}")
        lyric = (got.get("response") or {}).get("result", {}).get("lyric") or {}
        sync = lyric.get("syncLyric") or {}
        times = sync.get("startTimeIndex") or []
        parts = [one for one in (sync.get("contents") or []) if isinstance(one, dict)]
        body = next((p.get("text") for p in parts if p.get("languageType") == "default"),
                    (parts[0].get("text") if parts else None)) or []
        if not isinstance(times, list) or not isinstance(body, list):
            return None
        lines = [{"at": int(round(float(times[i]) * 1000)), "text": str(body[i]).strip()}
                 for i in range(min(len(times), len(body))) if str(body[i] or "").strip()]
        if not lines:
            return None
        artists = [a for a in (track.get("artists") or []) if isinstance(a, dict)]
        return {
            "artist": ", ".join(a.get("artistName") or "" for a in artists),
            "title": track.get("trackTitle") or "",
            "album": (track.get("album") or {}).get("albumTitle") or "",
            "duration": seconds(track.get("playTime")),
            "lines": lines, "instrumental": False, "has_end": False, "source": "vibe",
        }
    except Exception as error:
        # 삼키되 자국은 남긴다. 앞선 판은 조용히 None 을 돌려주어 검색이 빈손으로 왔는데,
        # 무엇이 터졌는지 알 길이 없어 서버 밖에서 다시 짜 맞춰야 했다.
        print(f"[vibe] {track.get('trackTitle')!r} 건너뜀: "
              f"{type(error).__name__}: {error}", file=sys.stderr, flush=True)
        return None


@app.get("/api/vibe")
def search_vibe(q: str = "", artist: str = "", title: str = "") -> list[dict]:
    """네이버 바이브에서 가사를 찾는다.

    한국 곡에는 LRCLIB 보다 이쪽이 낫다. LRCLIB 은 마흔 곡 중 다섯 곡만 쓸 만했고(싱크가 있는
    열여덟 중 열셋이 로마자였다) 바이브는 쳐 본 여덟 곡이 모두 한글 원문에 싱크까지 있었다.
    제품이 멜론·지니에서 받는 그 글자와 같은 계열이라 로마자 문제가 아예 없다.

    싱크는 나란한 두 배열로 온다 — `startTimeIndex[i]`(초)와 `contents[*].text[i]`. 예전
    구조(`lyricLine[].startTimeMillis`)는 이제 오지 않는데 `hasSyncLyric` 은 여전히 true 라
    깃발만 보아서는 알 수 없다.
    """
    words = " ".join(part for part in (title, artist, q) if part).strip()
    if not words:
        raise HTTPException(400, "검색어가 없다")
    found = vibe_get(f"/v3/search/track?query={urllib.parse.quote(words)}&start=1&display=8&sort=RELEVANCE")
    rows = (found.get("response") or {}).get("result", {}).get("tracks") or []
    tracks = [row for row in rows if isinstance(row, dict)][:6] if isinstance(rows, list) else []
    if not tracks:
        return []
    # 트랙마다 가사를 따로 받아야 한다. 줄 세워 받으면 여섯 번의 왕복이 그대로 쌓여
    # 사람이 기다리다 만다 — 함께 쏘고 온 순서가 아니라 검색 순서로 되돌린다.
    with ThreadPoolExecutor(max_workers=6) as pool:
        got = list(pool.map(vibe_lines, tracks))
    kept = [row for row in got if row]
    print(f"[vibe] {words!r} → 트랙 {len(tracks)} · 쓸 만한 것 {len(kept)}", file=sys.stderr, flush=True)
    return kept


@app.get("/api/youtube")
def search_youtube(q: str, want: int = 8) -> list[dict]:
    """유튜브에서 음원 후보를 찾는다. 내려받지 않고 정보만 본다."""
    binary = str(YTDLP) if YTDLP.exists() else str(HERE / ".venv/bin/yt-dlp")
    if not Path(binary).exists():
        raise HTTPException(503, f"yt-dlp 가 없다: {binary}")
    try:
        got = subprocess.run(
            [binary, "--no-playlist", "--flat-playlist", "--skip-download", "--dump-json",
             "--ignore-errors", f"ytsearch{want}:{q}"],
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "유튜브가 제때 답하지 않았다")
    out = []
    for line in got.stdout.splitlines():
        try:
            item = json.loads(line)
        except Exception:
            continue
        out.append({"video_id": item.get("id"), "title": item.get("title") or "",
                    "uploader": item.get("uploader") or item.get("channel") or "",
                    "duration": item.get("duration") or 0})
    return out


# ── 음원 ──────────────────────────────────────────────────────────────────────

# 원본에서 **만들어 낸** 소리들. 원본 옆에 같은 이름으로 두므로 원본을 고를 때 걸러야 한다.
MADE_FROM = (".vocals.wav", ".lead.wav", ".back.wav")


def audio_path(video_id: str) -> Path | None:
    """그 곡의 **원본** 음원.

    파생 파일을 걸러야 한다. 여기를 안 막아 두었다가 크게 당했다 — 보컬을 리드/서브로 가른
    뒤 `{video_id}.back.wav` 가 생겼는데, 그것이 `.m4a` 보다 사전순으로 앞서서
    `sorted(...)[0]` 이 **서브 보컬만 남은 소리**를 집었다. 사람이 듣는 재생도, 정렬의
    바탕도 통째로 그것이 됐다. 「음원이 이상하다 · 목소리가 기계음이다」가 그 증상이다.

    probe 들은 이 거르기를 제 안에 갖고 있어서 멀쩡했고, 서버만 틀렸다. 그래서 같은 곡을
    재는데 값이 달랐다 — **화면이 쓰는 것과 다른 것을 재고 있었다.**
    """
    found = sorted(AUDIO.glob(f"{video_id}.*"))
    return next((p for p in found
                 if p.suffix != ".part" and not p.name.endswith(MADE_FROM)), None)


def download(video_id: str) -> None:
    binary = str(YTDLP) if YTDLP.exists() else str(HERE / ".venv/bin/yt-dlp")
    try:
        got = subprocess.run(
            [binary, "--no-playlist", "--retries", "5", "-f", "bestaudio/best",
             "-x", "--audio-format", "m4a", "--audio-quality", "0",
             "-o", str(AUDIO / f"{video_id}.%(ext)s"),
             f"https://www.youtube.com/watch?v={video_id}"],
            stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=900)
        ok = audio_path(video_id) is not None
        with fetch_lock:
            fetching[video_id] = "done" if ok else f"실패: {got.stderr[-200:]}"
        if ok:
            # 음원이 오면 **바로 맞춘다.** 사람이 「모델로 맞추기」를 누를 일이 없어야 한다 —
            # 사람이 하는 일은 검수뿐이고, 모델이 낸 것이 곧 검수할 대상이다. 누를 단추로
            # 두면 곡마다 그 한 번을 기억해야 하고, 잊으면 빈 화면을 검수하게 된다.
            with db() as conn:
                row = conn.execute("SELECT id FROM songs WHERE video_id=?", (video_id,)).fetchone()
            if row is not None:
                threading.Thread(target=run_align, args=(row["id"],), daemon=True).start()
    except Exception as error:
        with fetch_lock:
            fetching[video_id] = f"실패: {type(error).__name__}"


@app.post("/api/audio/{video_id}")
def start_fetch(video_id: str) -> dict:
    if audio_path(video_id):
        return {"state": "done"}
    with fetch_lock:
        if fetching.get(video_id) == "받는중":
            return {"state": "받는중"}
        fetching[video_id] = "받는중"
    threading.Thread(target=download, args=(video_id,), daemon=True).start()
    return {"state": "받는중"}


@app.get("/api/audio/{video_id}")
def fetch_state(video_id: str) -> dict:
    if audio_path(video_id):
        return {"state": "done"}
    with fetch_lock:
        return {"state": fetching.get(video_id, "없음")}


@app.get("/audio/{video_id}")
def serve_audio(video_id: str):
    """FileResponse 가 Range 를 다룬다 — 그것이 없으면 브라우저가 앞으로 감기를 못 한다."""
    path = audio_path(video_id)
    if path is None:
        raise HTTPException(404, "아직 안 받았다")
    return FileResponse(path, media_type="audio/mp4")


# 그 곡을 다루며 만들어 낸 것들. 무엇에서 무엇이 나왔는지도 함께 적는다.
#
# 이름은 화면에 그대로 나가므로 여기서 정한다. `MADE_FROM` 과 짝이 맞아야 한다 —
# 갈래를 더하면 두 곳을 같이 고쳐야 한다.
STEMS = {
    # demucs 를 버리고 BS-Roformer 로 갈아탔다. 사람이 둘을 나란히 듣고 정했다 —
    # demucs 판은 「반주 걷어낸 게 별로」였고, 맞추기 성적은 같았으니 차이는 소리뿐이었다.
    "vocals": (".vocals.wav", "보컬", "BS-Roformer 가 반주를 걷어 낸 것 (SDR 12.98)", "원본"),
    "lead": (".lead.wav", "리드", "카라오케 모델이 가른 주 목소리 · 정렬의 바탕", "보컬"),
    "back": (".back.wav", "서브", "백보컬·애드리브 · 무너진 줄을 구제하는 데 쓴다", "보컬"),
}


def wav_form(path: Path) -> str | None:
    """그 wav 가 어떤 모양인가 — `44.1kHz · 2ch · 24bit`.

    화면에 내보이는 이유가 있다. 갈래를 16 kHz 홑소리로 남겨 두고 44.1 kHz 스테레오를 바라는
    모델에 넣고 있었는데, **숫자가 어디에도 안 보여서** 사람이 「소리가 깨진다」고 말해 줄
    때까지 몰랐다. 보이면 바로 안다.
    """
    import wave as wav
    if not path.exists():
        return None
    try:
        with wav.open(str(path)) as got:
            rate = got.getframerate()
            return (f"{rate / 1000:g}kHz · {got.getnchannels()}ch · "
                    f"{got.getsampwidth() * 8}bit")
    except Exception as error:
        print(f"[workspace] {path.name} 모양을 못 읽는다: {error}", file=sys.stderr, flush=True)
        return None


@app.get("/api/songs/{song_id}/workspace")
def workspace(song_id: int) -> dict:
    """그 곡의 **작업실** — 어떤 파일이 만들어졌고 각 단계가 무엇을 냈나.

    검수하다 「이 시각이 어디서 나온 거지」가 늘 막힌다. 원본과 갈래를 나란히 듣고 단계마다의
    결과를 함께 보면 그 물음에 스스로 답할 수 있다.
    """
    with db() as conn:
        row = conn.execute("SELECT * FROM songs WHERE id=?", (song_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "없는 곡")

    origin = audio_path(row["video_id"])
    files = []
    if origin is not None:
        files.append({
            "key": "origin", "name": origin.name, "label": "원본",
            "note": "유튜브에서 받은 그대로", "from": None,
            "bytes": origin.stat().st_size, "made_at": int(origin.stat().st_mtime),
            "url": f"/audio/{row['video_id']}",
        })
    for key, (tail, label, note, parent) in STEMS.items():
        got = AUDIO / f"{row['video_id']}{tail}"
        files.append({
            "key": key, "name": got.name, "label": label, "note": note, "from": parent,
            "bytes": got.stat().st_size if got.exists() else None,
            "made_at": int(got.stat().st_mtime) if got.exists() else None,
            "url": f"/stem/{row['video_id']}/{key}" if got.exists() else None,
            "form": wav_form(got),
        })

    # 단계마다 무엇이 나왔나. 파일이 없으면 그 단계는 아직 안 한 것이다.
    lines = json.loads(row["lines"])
    placed = [one for one in lines if one.get("words")]
    chars = [c for one in placed for w in one["words"] for c in (w.get("chars") or [])]
    steps = [
        {"name": "음원 받기", "done": origin is not None,
         "got": f"{origin.name}" if origin else "아직"},
        {"name": "가사", "done": bool(lines),
         "got": f"{len(lines)}줄 · 시각 있는 줄 {sum(1 for one in lines if one.get('at') is not None)}"},
        {"name": "반주 걷기", "done": (AUDIO / f"{row['video_id']}.vocals.wav").exists(),
         "got": "보컬 한 갈래"},
        {"name": "목소리 가르기", "done": (AUDIO / f"{row['video_id']}.lead.wav").exists(),
         "got": "리드 · 서브"},
        {"name": "소리에 맞추기", "done": bool(placed),
         "got": (f"{len(placed)}/{len(lines)}줄 · 글자 {len(chars)} · "
                 f"서브 레인 {sum(1 for one in lines if one.get('lane') == 1)} · "
                 f"무너짐 {sum(1 for one in placed if one['words'][0].get('stuck'))}")
                if placed else "아직"},
    ]
    return {"files": files, "steps": steps}


@app.get("/stem/{video_id}/{kind}")
def serve_stem(video_id: str, kind: str):
    """가른 갈래를 들려준다. 원본과 나란히 들어야 무엇이 갈렸는지 안다."""
    if kind not in STEMS:
        raise HTTPException(404, "그런 갈래가 없다")
    path = AUDIO / f"{video_id}{STEMS[kind][0]}"
    if not path.exists():
        raise HTTPException(404, "아직 안 만들었다")
    return FileResponse(path, media_type="audio/wav")


# ── 내보내기 ──────────────────────────────────────────────────────────────────

@app.get("/api/export")
def export() -> JSONResponse:
    """검수를 통과한 것만 정답 파일 모양으로 내보낸다."""
    with db() as conn:
        rows = conn.execute("SELECT * FROM songs WHERE verdict IN ('good','off') ORDER BY artist").fetchall()
    out = []
    for row in rows:
        lines = json.loads(row["lines"])
        shift = row["offset_ms"]
        out.append({
            "video_id": row["video_id"], "artist": row["artist"], "title": row["title"],
            "language": row["language"], "duration": row["duration"],
            # 사람이 맞춘 치우침은 여기서 미리 더해 내보낸다. 재는 쪽은 그대로 쓰면 된다.
            "lines": [{"at": line["at"] + shift, "text": line["text"]} for line in lines],
        })
    return JSONResponse(out, headers={"Content-Disposition": 'attachment; filename="korean-truth.json"'})


# Vite 가 빌드한 것을 그대로 내준다. /api 와 /audio 를 먼저 잡아 두었으므로 나머지가 화면이다.
DIST = HERE / "ui" / "dist"
if (DIST / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")


@app.get("/{whatever:path}", response_class=HTMLResponse)
def index(whatever: str = "") -> HTMLResponse:
    page = DIST / "index.html"
    if not page.exists():
        raise HTTPException(503, "화면이 아직 안 지어졌다 — ui 에서 npm run build")
    # 이 문서는 캐시하지 않는다.
    #
    # 번들 파일 이름에는 해시가 붙어 새로 지으면 이름이 바뀌지만, 그 이름을 가리키는 것은
    # 이 문서다. 이것이 캐시되면 새로 지어 올려도 브라우저는 옛 번들을 계속 불러온다 —
    # 서버도 소스도 번들도 최신인데 화면만 옛것인 상태가 되고, 그것을 코드 문제로 알고
    # 한참 뒤졌다.
    return HTMLResponse(page.read_text(encoding="utf-8"),
                        headers={"Cache-Control": "no-store, must-revalidate"})


setup()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8787, log_level="warning")
