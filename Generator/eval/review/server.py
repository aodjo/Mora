#!/usr/bin/env python3
"""
Throwaway tool for reviewing the Korean ground truth by ear.

Whether the fifty-five songs `korean.py` scraped off LRCLIB really carry the right timings
is something a person has to hear and see. Before spending two hours of GPU time, checking
that the ruler itself is sound comes first — in one day we were fooled three times by a bad
ruler.

Runs on the Galaxy Book only. It is reachable only inside Tailscale, so no authentication is
set up. This is not a thing to open to the outside.

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

#: Directory this server file sits in; every other path is resolved from it.
HERE = Path(__file__).parent
#: SQLite database holding the songs under review.
DB = HERE / "review.db"
#: Directory holding the downloaded originals and every stem derived from them.
AUDIO = HERE / "audio"
#: Standalone `yt-dlp` executable; when that single file is absent the venv one is used.
YTDLP = HERE.parent / "yt-dlp"
#: Ground-truth file scraped off LRCLIB, kept alongside for reference.
SEED = HERE / "korean-truth.json"
#: User-Agent sent to LRCLIB so our requests are identifiable.
AGENT = "Mora/0.1 (https://mora.junx.dev)"

def yt_dlp() -> str:
    """Find `yt-dlp` wherever it happens to be installed.

    Every machine is set up differently — the Galaxy Book and the msi use a venv, the rented
    GPU box uses conda. Looking at `.venv/bin/yt-dlp` alone meant songs could not be added,
    failing with "yt-dlp is missing". The known places are checked in turn and PATH is asked
    only when none of them has it.

    @returns {str} Absolute path to a usable `yt-dlp` executable.
    @throws {RuntimeError} If `yt-dlp` is in neither the known places nor PATH.
    """
    import shutil
    for one in (YTDLP, HERE / ".venv/bin/yt-dlp"):
        if one.exists():
            return str(one)
    found = shutil.which("yt-dlp")
    if found:
        return found
    raise RuntimeError("yt-dlp 를 못 찾는다 — venv 에도 PATH 에도 없다")


AUDIO.mkdir(exist_ok=True)
app = FastAPI(title="Mora 정답 검수")

#: Which song is being downloaded right now, keyed by video id — downloading takes a while.
fetching: dict[str, str] = {}
#: Guards `fetching` against the download threads.
fetch_lock = threading.Lock()


def db() -> sqlite3.Connection:
    """Open a connection to the review database.

    Rows come back as `sqlite3.Row` so they can be read by column name, and WAL is turned on
    because the download and alignment threads write while request handlers read. The 30
    second timeout keeps those writers from failing outright when they collide.

    @returns {sqlite3.Connection} An open connection, rows keyed by name and WAL enabled.
    """
    conn = sqlite3.connect(DB, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def setup() -> None:
    """Create the songs table when it is not there yet.

    The scraped fifty-five songs are deliberately not pre-loaded. Pushing them all in would
    turn the review into "skimming what is already there", when choosing what to put in is
    itself part of the review.

    @returns {None}
    """
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
          -- The verdict a person reached by listening. Null means not yet heard.
          verdict TEXT NULL CHECK (verdict IN ('good', 'off', 'wrong', 'drop')),
          note TEXT NOT NULL DEFAULT '',
          -- Shift (ms) dialled in by hand when a whole song is off by a constant amount.
          offset_ms INTEGER NOT NULL DEFAULT 0,
          added_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS songs_video ON songs(video_id);
        """)


def row_to_song(row: sqlite3.Row, with_lines: bool = False) -> dict:
    """Turn a database row into the song shape the screen reads.

    `lines` is stored as a JSON string, so the line count comes from decoding it, and
    `has_audio` is decided by looking for a file rather than by a column — downloading
    happens outside the database. The full lines are attached only when asked for, since the
    song list would otherwise carry every word of every song.

    @param {sqlite3.Row} row - A row of the `songs` table.
    @param {bool} [with_lines=False] - Whether to include the decoded `lines` array.
    @returns {dict} The song in the shape the screen expects.
    """
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


@app.get("/api/songs")
def list_songs() -> list[dict]:
    """List every song under review, ordered by artist then title.

    Lines are left out so the list stays small; a song's lines arrive when it is opened.

    @returns {list[dict]} Every song, without its lines.
    """
    with db() as conn:
        return [row_to_song(r) for r in conn.execute("SELECT * FROM songs ORDER BY artist, title")]


@app.get("/api/songs/{song_id}")
def get_song(song_id: int) -> dict:
    """Fetch one song with its lines, kicking off the alignment when nothing is placed yet.

    When the audio is there but no line carries words, the alignment is started **right
    here**. The only thing a person does is review; aligning is the model's job and the
    person only judges whether its result is right. So opening a song must never show an
    empty screen — that would mean there is nothing to review. A run already in flight is
    left alone.

    @param {int} song_id - Row id of the song.
    @returns {dict} The song including its lines.
    @throws {HTTPException} 404 when no song has that id.
    """
    with db() as conn:
        row = conn.execute("SELECT * FROM songs WHERE id=?", (song_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "없는 곡")

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
    """Update only the fields the request actually carries.

    The editable field names are listed here rather than taken from the body, so a stray key
    cannot reach the UPDATE statement. Lines are not editable through this route; they have
    one of their own.

    @async
    @param {int} song_id - Row id of the song.
    @param {Request} request - Request whose JSON body holds the fields to change.
    @returns {dict} The updated song including its lines.
    @throws {HTTPException} 400 when the body carries none of the editable fields, 404 when no song has that id.
    """
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
    """Replace the lines and the words inside them wholesale.

    Word timings are tapped in by a person listening to the song. LRCLIB effectively does not
    have them, and building them from our own pipeline's output would freeze the pipeline's
    mistakes into the ground truth. There is no other road to a Korean word-level ground
    truth, so it is made by hand.

    @async
    @param {int} song_id - Row id of the song.
    @param {Request} request - Request whose JSON body is the whole array of lines.
    @returns {dict} The song with its new lines.
    @throws {HTTPException} 400 when the body is not a non-empty list, 404 when no song has that id.
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


#: Which song is being aligned right now, keyed by song id.
#:
#: Forced alignment takes a long time (vocal extraction + voice splitting + alignment), so
#: both the song in flight and the trail it has walked are kept here.
aligning: dict[int, str] = {}
#: The trail of steps each alignment has walked, keyed by song id.
#:
#: A single-line status was not enough. One song takes 3 to 5 minutes, and with only
#: "extracting vocals" on screen there is no telling whether it is stuck or merely slow, and
#: once it ends nothing is left of what happened. Stacked up like a terminal, a person reads
#: it and judges on the spot.
align_log: dict[int, list[dict]] = {}
#: Guards `aligning` and `align_log` against the alignment threads.
align_lock = threading.Lock()


def note(song_id: int, text: str, kind: str = "step") -> None:
    """Append one line to a song's trail and make it the current state.

    A few dozen lines per song is plenty; beyond that the oldest are dropped, keeping the
    last 60.

    @param {int} song_id - Row id of the song being aligned.
    @param {str} text - The line of trail to record.
    @param {str} [kind="step"] - `step` (in progress), `done` (finished) or `bad` (failed).
    @returns {None}
    """
    with align_lock:
        aligning[song_id] = text
        align_log.setdefault(song_id, []).append(
            {"at": time.time(), "text": text, "kind": kind})
        align_log[song_id] = align_log[song_id][-60:]
#: Matches a token made only of punctuation or interlude marks, which has nothing to sing.
NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")


def align_words(text: str) -> list[str]:
    """Keep only the tokens worth aligning.

    Interlude marks (♫) have nothing to sing, so they are dropped.

    @param {str} text - The text of one line.
    @returns {list[str]} The tokens that carry something sung.
    """
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def run_align(song_id: int, fresh: bool = False) -> None:
    """Align with the models; when `fresh`, **rebuild the stems from scratch first.**

    Using the cached stems as they are prints "vocals extracted · 0s". For a first run that
    is right, but **when the person pressed "align again" it is wrong** — that means "from
    the start, with the current code". Fixing the splitting side and then aligning against the
    old stems leaves no way to tell what the fix did.

    Only the lines that were placed are swapped in; the lines that failed keep whatever the
    person laid down, because covering a failed line with a blank erases their work.

    The tally counts **only the singable lines.** Lines like the `♫` of an interlude have
    nothing to align, so they come out of the denominator — written as `28/31` it reads as
    three lines missed, and with no way for a person to fix them by hand right now that
    misreading turns into "something is badly wrong". Those three were in fact all `♫`.

    This runs on a background thread where nothing would catch a failure, so exceptions are
    printed to stderr and recorded in the trail instead of being raised.

    @param {int} song_id - Row id of the song to align.
    @param {bool} [fresh=False] - Delete the derived stems first and make them again.
    @returns {None}
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

        next_lines = [{**line, "words": got[index], "lane": lanes.get(index, 0)}
                      if got[index] else line
                      for index, line in enumerate(lines)]
        with db() as conn:
            conn.execute("UPDATE songs SET lines=? WHERE id=?",
                         (json.dumps(next_lines, ensure_ascii=False), song_id))
        singable = sum(1 for line in lines if align_words(line.get("text", "")))
        done = sum(1 for one in got if one)
        skipped = len(lines) - singable
        chars = sum(len(word.get("chars") or []) for line in got for word in line)
        stuck = sum(1 for line in got if line and line[0].get("stuck"))
        voices = max(lanes.values(), default=0) + 1
        note(song_id, f"글자 {chars} · 목소리 {voices}갈래 · 무너진 줄 {stuck}")
        note(song_id,
             f"done {done}/{singable} · 통틀어 {time.time() - began:.0f}초"
             + (f" · 부를 것 없는 줄 {skipped}" if skipped else ""), "done")
    except Exception as error:
        print(f"[align] {song_id} 실패: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        note(song_id, f"실패: {type(error).__name__}: {error}", "bad")


@app.post("/api/songs/{song_id}/align")
def start_align(song_id: int, fresh: bool = False) -> dict:
    """Align with our model; with `?fresh=1`, **rebuild the stems from scratch first.**

    What comes out is **a starting point, not the ground truth.** It means something only
    once a person has listened and judged — leaving it as it is and pressing "good" would
    turn our model's mistakes into the ground truth, and then we would be measuring our model
    against them.

    Whether a run is in flight is decided by exclusion. Listing the step names here would mean
    editing this spot every time a step name is added; anything that is neither finished
    (`done`) nor a failure is running.

    @param {int} song_id - Row id of the song to align.
    @param {bool} [fresh=False] - Delete the derived stems first and make them again.
    @returns {dict} The state, either of the run already in flight or of the one just started.
    """
    with align_lock:
        now = aligning.get(song_id, "")
        if now and not now.startswith(("done", "실패")):
            return {"state": now}
        aligning[song_id] = "보컬 뽑는 중"
    threading.Thread(target=run_align, args=(song_id, fresh), daemon=True).start()
    return {"state": "보컬 뽑는 중"}


@app.get("/api/songs/{song_id}/align")
def align_state(song_id: int) -> dict:
    """Report a song's current alignment state together with its whole trail.

    @param {int} song_id - Row id of the song.
    @returns {dict} The current `state` and the `log` of trail entries.
    """
    with align_lock:
        return {"state": aligning.get(song_id, "없음"),
                "log": list(align_log.get(song_id, []))}


@app.delete("/api/songs/{song_id}")
def drop_song(song_id: int) -> dict:
    """Take a song out of the review set.

    Only the row goes; the downloaded audio and its stems stay on disk.

    @param {int} song_id - Row id of the song.
    @returns {dict} `{"ok": True}`.
    """
    with db() as conn:
        conn.execute("DELETE FROM songs WHERE id=?", (song_id,))
    return {"ok": True}


@app.post("/api/songs")
async def add_song(request: Request) -> dict:
    """Put a song into the review set, replacing any row that has the same video id.

    Every required field has to be non-empty, so a song cannot land with zero lines or a
    zero duration and then look like a broken alignment later.

    @async
    @param {Request} request - Request whose JSON body carries video_id, artist, title, duration and lines.
    @returns {dict} The stored song including its lines.
    @throws {HTTPException} 400 when any required field is missing or empty.
    """
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


#: Matches one LRC line, `[mm:ss.xx] text`, with either hundredths or milliseconds.
STAMP = re.compile(r"^\[(\d{2}):(\d{2})[.:](\d{2,3})\]\s*(.*)$")


def parse_lrc(synced: str) -> list[dict]:
    """Read an LRC body into lines carrying a start time in milliseconds.

    The fraction is two or three digits depending on the file, so two digits are read as
    hundredths and scaled by ten. Stamps with no text behind them are dropped — LRC leaves
    those where the interludes are.

    @param {str} synced - The LRC body.
    @returns {list[dict]} Lines with `at` in milliseconds and `text`.
    """
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


#: Matches one `lyricsfile` entry — its text plus the `start_ms` and optional `end_ms` below.
#:
#: `lyricsfile` is better than LRC — it gives the **end** time of a line as well. LRC gives
#: only the start, so a "start is right, end is wrong" alignment cannot be measured. Of two
#: hundred entries, a hundred and seventy-six had end_ms.
#:
#: The format also has a word level (`words:`), but only one of the two hundred had it, and
#: even that one had just the first line filled and `words: []` for the rest. Nobody fills it
#: in — which is why the word-level ground truth is tapped in by a person.
FILE_LINE = re.compile(
    r"^\s*-\s+text:\s*(?P<text>.*?)\s*$\n(?:(?!^\s*-\s+text:).*\n)*?"
    r"^\s+start_ms:\s*(?P<start>\d+)\s*$(?:\n^\s+end_ms:\s*(?P<end>\d+)\s*$)?",
    re.M)


def unquote(raw: str) -> str:
    """Strip one layer of matching quotes off a `lyricsfile` value.

    @param {str} raw - The raw value, possibly wrapped in single or double quotes.
    @returns {str} The value with its surrounding whitespace and one matching quote pair removed.
    """
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        return raw[1:-1]
    return raw


def parse_lyricsfile(text: str) -> list[dict]:
    """Pull each line's start and end out of a `lyricsfile`.

    Read by hand rather than with a YAML parser, so that no YAML parser has to be pulled in.
    Entries whose text is empty are interlude marks and have nothing to measure, so they are
    skipped.

    @param {str} text - The `lyricsfile` body.
    @returns {list[dict]} Lines with `at` and `text`, plus `end` where the entry carried one.
    """
    rows = []
    for hit in FILE_LINE.finditer(text):
        body = unquote(hit.group("text"))
        if not body:
            continue
        row = {"at": int(hit.group("start")), "text": body}
        if hit.group("end"):
            row["end"] = int(hit.group("end"))
        rows.append(row)
    return rows


def best_lines(item: dict) -> list[dict]:
    """Take whichever source carries end times, falling back to LRC when neither does.

    @param {dict} item - One LRCLIB search result.
    @returns {list[dict]} The parsed lines, empty when neither source has anything.
    """
    rows = parse_lyricsfile(item.get("lyricsfile") or "")
    if rows and any("end" in row for row in rows):
        return rows
    return parse_lrc(item.get("syncedLyrics") or "")


#: Matches a single Hangul syllable, used to reduce an artist name to its Korean part.
HANGUL = re.compile(r"[가-힣]")


def artist_core(name: str) -> str:
    """See the same person written two ways as one — 「악뮤」 and 「AKMU (악뮤)」 are the same.

    When the name has Hangul in it only the Hangul is kept; otherwise it falls back to the
    lowercase alphanumerics.

    @param {str} name - The artist name as written.
    @returns {str} A comparable core form of the name.
    """
    hangul = "".join(HANGUL.findall(name))
    return hangul or re.sub(r"[^a-z0-9]", "", name.lower())


@app.get("/api/lrclib")
def search_lrclib(q: str = "", artist: str = "", title: str = "") -> list[dict]:
    """Search LRCLIB for lyrics, returning only the entries that carry a sync.

    This API accepts only three combinations — found by measuring, not by reading:
      * `q=` free search. It sweeps artistName, trackName and albumName together.
      * `track_name=` alone. Works.
      * `track_name=` plus `artist_name=`. Works.
      * **`artist_name=` alone comes back with 0 rows.** So an artist-only search asks with
        `q=` and then keeps only the rows whose artist field really matches — asking for
        「지코」 otherwise brings back an `artistName="Hamah Music"` row, matched on the album
        field, in first place.

    Something other than a list comes back at times (an error object and such), so the type
    is checked before any filtering — iterating a dict hands string keys onward, and the
    missing `.get` turns into a 500.

    @param {str} [q=""] - Free-text query.
    @param {str} [artist=""] - Artist name.
    @param {str} [title=""] - Track title.
    @returns {list[dict]} The candidates that carry lines, with artist, title, album, duration and flags.
    @throws {HTTPException} 400 when no search term is given, 502 when LRCLIB cannot be reached.
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


#: Base URL of Naver Vibe's music web API.
VIBE = "https://apis.naver.com/vibeWeb/musicapiweb"
#: Desktop browser User-Agent sent to Vibe alongside the web player's Referer.
BROWSER = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
           "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def vibe_get(path: str, tries: int = 3) -> dict:
    """GET one Vibe endpoint, retrying instead of coming back empty-handed on one break.

    Naver drops a connection now and then, so a single break is not the answer. The wait
    grows with each attempt, and only after the last one does it give up, leaving a line on
    stderr rather than raising.

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
    """Turn Vibe's `playTime`, written as `"04:03"`, into seconds.

    LRCLIB's `duration` is a float in seconds, so this was read with `float()` to match that
    side, and here that blows up wholesale — six songs vanished quietly behind a swallowed
    exception. Numbers pass straight through, `h:mm:ss` and `mm:ss` both fold through the
    same running multiply, and anything unreadable becomes 0.

    @param {object} raw - The duration as Vibe wrote it, or already a number.
    @returns {float} The duration in seconds, 0.0 when it cannot be read.
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
            for one in parts:
                total = total * 60 + one
            return total
        return float(text)
    except ValueError:
        return 0.0


def vibe_lines(track: dict) -> dict | None:
    """Fetch one track's lyrics and reshape them into our form, dropping anything unsynced.

    One song falling over must not stop the rest. Six are fired off together, and if one of
    them comes back in an unexpected shape `pool.map` re-raises it on the spot and the whole
    search turns into a 500.

    The exception is swallowed, but a mark is left behind. An earlier version quietly returned
    None, the search came back empty-handed, and there was no way to tell what had broken
    without piecing it back together outside the server.

    @param {dict} track - One track out of the Vibe search result.
    @returns {dict | None} The song shape with its lines, or None when there is no usable sync.
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
        print(f"[vibe] {track.get('trackTitle')!r} 건너뜀: "
              f"{type(error).__name__}: {error}", file=sys.stderr, flush=True)
        return None


@app.get("/api/vibe")
def search_vibe(q: str = "", artist: str = "", title: str = "") -> list[dict]:
    """Search Naver Vibe for lyrics.

    For Korean songs this beats LRCLIB. Of forty songs LRCLIB gave only five that were usable
    (of the eighteen that had a sync, thirteen were romanised), while all eight songs tried on
    Vibe had the Hangul original and a sync besides. It is the same lineage of text the
    product gets from Melon and Genie, so the romanisation problem does not arise at all.

    The sync arrives as two parallel arrays — `startTimeIndex[i]` (seconds) and
    `contents[*].text[i]`. The old structure (`lyricLine[].startTimeMillis`) no longer comes,
    yet `hasSyncLyric` is still true, so the flag alone tells you nothing.

    Lyrics have to be fetched per track. Fetched in a row, six round trips pile straight up
    and the person gives up waiting — so they are fired together and put back into search
    order rather than the order they returned in.

    @param {str} [q=""] - Free-text query.
    @param {str} [artist=""] - Artist name.
    @param {str} [title=""] - Track title.
    @returns {list[dict]} The tracks that carried a usable sync, in search order.
    @throws {HTTPException} 400 when no search term is given.
    """
    words = " ".join(part for part in (title, artist, q) if part).strip()
    if not words:
        raise HTTPException(400, "검색어가 없다")
    found = vibe_get(f"/v3/search/track?query={urllib.parse.quote(words)}&start=1&display=8&sort=RELEVANCE")
    rows = (found.get("response") or {}).get("result", {}).get("tracks") or []
    tracks = [row for row in rows if isinstance(row, dict)][:6] if isinstance(rows, list) else []
    if not tracks:
        return []
    with ThreadPoolExecutor(max_workers=6) as pool:
        got = list(pool.map(vibe_lines, tracks))
    kept = [row for row in got if row]
    print(f"[vibe] {words!r} → 트랙 {len(tracks)} · 쓸 만한 것 {len(kept)}", file=sys.stderr, flush=True)
    return kept


@app.get("/api/youtube")
def search_youtube(q: str, want: int = 8) -> list[dict]:
    """Search YouTube for audio candidates, reading the metadata without downloading.

    Locating the binary happens in `yt_dlp()` and nowhere else. The same lines used to sit
    here and in the download path in two copies, and after fixing only the download path the
    search went on reporting "yt-dlp is missing".

    @param {str} q - The search query.
    @param {int} [want=8] - How many results to ask for.
    @returns {list[dict]} Candidates with video_id, title, uploader and duration.
    @throws {HTTPException} 503 when `yt-dlp` cannot be found, 504 when YouTube does not answer in time.
    """
    try:
        binary = yt_dlp()
    except RuntimeError as error:
        raise HTTPException(503, str(error)) from None
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


#: Suffixes of the sounds **made from** the original. They sit next to the original under the
#: same name, so they have to be filtered out when picking the original.
MADE_FROM = (".vocals.wav", ".lead.wav", ".back.wav")


def audio_path(video_id: str) -> Path | None:
    """The song's **original** audio.

    The derived files have to be filtered out. Not blocking that here cost us dearly — after
    splitting the vocals into lead and backing, `{video_id}.back.wav` appeared, and since it
    sorts ahead of `.m4a` alphabetically, `sorted(...)[0]` picked up **the sound with only the
    backing vocals left**. Both the playback the person heard and the ground the alignment
    stood on became that file wholesale. "The audio is wrong · the voice sounds robotic" was
    the symptom.

    The probes carried this filtering inside themselves and were fine; only the server was
    wrong. That is why measuring the same song gave different numbers — **we were measuring
    something other than what the screen was using.** Half-finished downloads (`.part`) are
    skipped as well.

    @param {str} video_id - YouTube video id of the song.
    @returns {Path | None} Path to the original audio, or None when it has not been downloaded.
    """
    found = sorted(AUDIO.glob(f"{video_id}.*"))
    return next((p for p in found
                 if p.suffix != ".part" and not p.name.endswith(MADE_FROM)), None)


def download(video_id: str) -> None:
    """Fetch a song's audio with `yt-dlp` and start the alignment the moment it lands.

    Success is judged by whether the file is actually there afterwards, not by the exit code.
    When the audio arrives the alignment runs **straight away**: the person should never have
    to press "align with the model" — the only thing they do is review, and what the model
    produced is the thing to be reviewed. Left as a button it would have to be remembered once
    per song, and forgetting it means reviewing an empty screen.

    This runs on a background thread, so failures are recorded in `fetching` rather than
    raised.

    @param {str} video_id - YouTube video id to fetch.
    @returns {None}
    """
    binary = yt_dlp()
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
            with db() as conn:
                row = conn.execute("SELECT id FROM songs WHERE video_id=?", (video_id,)).fetchone()
            if row is not None:
                threading.Thread(target=run_align, args=(row["id"],), daemon=True).start()
    except Exception as error:
        with fetch_lock:
            fetching[video_id] = f"실패: {type(error).__name__}"


@app.post("/api/audio/{video_id}")
def start_fetch(video_id: str) -> dict:
    """Start downloading a song's audio, or report the download already in flight.

    Audio already on disk counts as done, so pressing the button again downloads nothing.

    @param {str} video_id - YouTube video id to fetch.
    @returns {dict} The download state.
    """
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
    """Report the download state of one song's audio.

    A file already on disk counts as done whatever the in-memory table says, because that
    table does not survive a restart.

    @param {str} video_id - YouTube video id.
    @returns {dict} The download state.
    """
    if audio_path(video_id):
        return {"state": "done"}
    with fetch_lock:
        return {"state": fetching.get(video_id, "없음")}


@app.get("/audio/{video_id}")
def serve_audio(video_id: str):
    """Serve the original audio.

    `FileResponse` handles Range — without it the browser cannot seek.

    @param {str} video_id - YouTube video id.
    @returns {FileResponse} The original audio file.
    @throws {HTTPException} 404 when the audio has not been downloaded yet.
    """
    path = audio_path(video_id)
    if path is None:
        raise HTTPException(404, "아직 안 받았다")
    return FileResponse(path, media_type="audio/mp4")


#: Everything made while working on a song, along with what each one came out of.
#:
#: The labels go straight to the screen, so they are decided here. This has to stay paired
#: with `MADE_FROM` — adding a stem means fixing both places together.
#:
#: demucs was dropped in favour of BS-Roformer. A person listened to the two side by side and
#: decided: the demucs version was "not great at stripping the backing", and the alignment
#: scores were the same, so the only difference was the sound.
STEMS = {
    "vocals": (".vocals.wav", "보컬", "BS-Roformer 가 반주를 걷어 낸 것 (SDR 12.98)", "원본"),
    "lead": (".lead.wav", "리드", "카라오케 모델이 가른 주 목소리 · 정렬의 바탕", "보컬"),
    "back": (".back.wav", "서브", "백보컬·애드리브 · 무너진 줄을 구제하는 데 쓴다", "보컬"),
}


def wav_form(path: Path) -> str | None:
    """What shape that wav has — `44.1kHz · 2ch · 24bit`.

    There is a reason for putting it on screen. The stems were being left at 16 kHz mono and
    fed to a model that wants 44.1 kHz stereo, and **because the numbers were nowhere to be
    seen** nobody knew until a person said "the sound breaks up". Once shown, it is obvious at
    a glance.

    @param {Path} path - Path to the wav file.
    @returns {str | None} The formatted shape, or None when the file is missing or unreadable.
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
    """That song's **workshop** — which files were made, and what each step produced.

    While reviewing, "where did this timing come from" is forever the thing that blocks the
    way. Listening to the original and the stems side by side while seeing each step's result
    lets a person answer that question themselves. A step whose file is missing has simply not
    been done yet.

    @param {int} song_id - Row id of the song.
    @returns {dict} `files` for the original and every stem, and `steps` for what each stage produced.
    @throws {HTTPException} 404 when no song has that id.
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
    """Play back one split stem.

    It has to be heard next to the original before you can tell what was split off.

    @param {str} video_id - YouTube video id.
    @param {str} kind - Stem key, one of `STEMS`.
    @returns {FileResponse} The stem file.
    @throws {HTTPException} 404 when the stem is unknown or has not been made yet.
    """
    if kind not in STEMS:
        raise HTTPException(404, "그런 갈래가 없다")
    path = AUDIO / f"{video_id}{STEMS[kind][0]}"
    if not path.exists():
        raise HTTPException(404, "아직 안 만들었다")
    return FileResponse(path, media_type="audio/wav")


@app.get("/api/export")
def export() -> JSONResponse:
    """Export only what passed review, in the shape of the ground-truth file.

    Only the `good` and `off` verdicts go out. The shift a person dialled in is added here
    before it leaves, so the measuring side can use the lines as they are.

    @returns {JSONResponse} The ground-truth rows, sent as a `korean-truth.json` attachment.
    """
    with db() as conn:
        rows = conn.execute("SELECT * FROM songs WHERE verdict IN ('good','off') ORDER BY artist").fetchall()
    out = []
    for row in rows:
        lines = json.loads(row["lines"])
        shift = row["offset_ms"]
        out.append({
            "video_id": row["video_id"], "artist": row["artist"], "title": row["title"],
            "language": row["language"], "duration": row["duration"],
            "lines": [{"at": line["at"] + shift, "text": line["text"]} for line in lines],
        })
    return JSONResponse(out, headers={"Content-Disposition": 'attachment; filename="korean-truth.json"'})


#: Directory Vite builds the UI into; it is served as built. /api and /audio are claimed
#: first, so everything left over is the screen.
DIST = HERE / "ui" / "dist"
if (DIST / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")


@app.get("/{whatever:path}", response_class=HTMLResponse)
def index(whatever: str = "") -> HTMLResponse:
    """Serve the built screen for every path the API and audio routes did not claim.

    This document is never cached. Bundle filenames carry a hash, so a rebuild changes their
    names, but the thing pointing at those names is this document. Once it is cached the
    browser goes on loading the old bundle even after a fresh build is deployed — server,
    source and bundle all current while only the screen is old, and that was hunted for a long
    time as a code problem.

    @param {str} [whatever=""] - The requested path, which is ignored.
    @returns {HTMLResponse} The built `index.html`, served with caching turned off.
    @throws {HTTPException} 503 when the screen has not been built yet.
    """
    page = DIST / "index.html"
    if not page.exists():
        raise HTTPException(503, "화면이 아직 안 지어졌다 — ui 에서 npm run build")
    return HTMLResponse(page.read_text(encoding="utf-8"),
                        headers={"Cache-Control": "no-store, must-revalidate"})


setup()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8787, log_level="warning")
