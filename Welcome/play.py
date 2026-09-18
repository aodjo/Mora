#!/usr/bin/env python3
"""노래를 틀면서 가사를 글자마다 칠한다 — Mora 타이밍이 실제로 어떤지 눈으로 보는 자리.

낱말마다 시각이 있으므로 낱말 **안에서도** 칠할 수 있다: 「흘려보내요」가 2.6초 동안 불린다면
그 2.6초에 걸쳐 다섯 글자가 차례로 진해진다. 줄만 칠하는 자막과 다른 점이 그것이다.

    python play.py 노래.m4a --artist "리도어(Redoor)" --title "영원은 그렇듯"
    python play.py 노래.m4a 가사.txt --isrc KRA401200001

가사 파일을 안 주면 제공처(bugs·flo·genie·melon·vibe)에서 받아 온다 — 그러려면 `--artist`
와 `--title` 이 있어야 한다.

소리를 내는 길이 둘이다. `sounddevice` 와 `soundfile` 이 있으면 **표본을 세어** 자리를 안다 —
시계가 밀리지 않는다. 없으면 `ffplay` 를 띄우고 시계로 센다. 그쪽은 재생기가 뜨는 만큼 조금
늦으므로 `--offset` 으로 맞춘다.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

#: 아직 안 부른 글자.
DIM = (92, 100, 112)
#: 다 부른 글자.
LIT = (236, 232, 226)
#: 지금 부르는 글자가 도달하는 색 — 여기서 「진해진다」.
NOW = (232, 160, 104)
#: 화면에 현재 줄 위아래로 몇 줄을 보여 줄지.
AROUND = 3


def paint(text: str, colour: tuple[int, int, int], bold: bool = False) -> str:
    """Wrap text in a truecolor escape.

    @param {str} text - What to print.
    @param {tuple} colour - (r, g, b).
    @param {bool} bold - Whether to embolden it.
    @returns {str} The escaped string.
    """
    r, g, b = colour
    return f"\033[{'1;' if bold else ''}38;2;{r};{g};{b}m{text}\033[0m"


def blend(a: tuple[int, int, int], b: tuple[int, int, int], amount: float) -> tuple[int, int, int]:
    """Mix two colours.

    @param {tuple} a - From.
    @param {tuple} b - To.
    @param {float} amount - 0 stays at a, 1 reaches b.
    @returns {tuple} The mixed colour.
    """
    amount = min(1.0, max(0.0, amount))
    return tuple(round(one + (two - one) * amount) for one, two in zip(a, b))  # type: ignore[return-value]


def width_of(text: str) -> int:
    """How many terminal columns a string takes.

    한글은 한 글자가 두 칸이다. 이것을 안 세면 줄 가운데 맞추기가 어긋난다.

    @param {str} text - The string.
    @returns {int} Columns.
    """
    return sum(2 if unicodedata.east_asian_width(one) in "WF" else 1 for one in text)


def line_art(line, position_ms: int) -> str:
    """Paint one line, character by character, for this moment.

    낱말이 불리는 동안 그 낱말의 글자들이 차례로 진해진다. 낱말 안의 글자 시각은 없으므로 낱말
    길이를 글자 수로 고르게 나눈다 — 노래가 실제로 그렇지는 않지만, 눈에는 부드럽게 흐른다.

    @param {Line} line - The line to paint.
    @param {int} position_ms - Where the song is now.
    @returns {str} The painted line.
    """
    if not line.words:
        lit = position_ms >= line.start_ms
        return paint(line.text, LIT if lit else DIM, bold=lit)

    out: list[str] = []
    spot = line.start
    for word in line.words:
        #: 낱말 사이의 공백·기호도 그대로 둔다 — 가사 글 그대로 보여야 한다.
        if word.start > spot:
            out.append(paint(line.text[spot - line.start:word.start - line.start], DIM))
        text = word.text
        if position_ms >= word.end_ms:
            out.append(paint(text, LIT, bold=True))
        elif position_ms < word.start_ms:
            out.append(paint(text, DIM))
        else:
            #: 지금 부르는 낱말. 글자마다 제 차례가 얼마나 지났는지로 색을 고른다.
            each = max(1, word.duration_ms) / max(1, len(text))
            gone = position_ms - word.start_ms
            for index, one in enumerate(text):
                share = (gone - index * each) / each
                if share >= 1:
                    out.append(paint(one, LIT, bold=True))
                elif share <= 0:
                    out.append(paint(one, DIM))
                else:
                    out.append(paint(one, blend(DIM, NOW, share), bold=True))
        spot = word.end
    if spot < line.end:
        out.append(paint(line.text[spot - line.start:], DIM))
    return "".join(out)


def draw(alignment, head, position_ms: int, columns: int, title: str) -> None:
    """Redraw the screen for this moment.

    @param {Alignment} alignment - The timed lyrics.
    @param {Playhead} head - The cursor that follows the song.
    @param {int} position_ms - Where the song is now.
    @param {int} columns - Terminal width.
    @param {str} title - What to show at the top.
    @returns {None}
    """
    now = head.at(position_ms)
    centre = now.line_number
    if centre is None:
        #: 간주에는 다음에 올 줄을 가운데 둔다 — 화면이 멎어 있으면 멈춘 줄 안다.
        centre = next((k for k, one in enumerate(alignment.lines) if one.start_ms > position_ms), len(alignment.lines) - 1)

    rows = [f"\033[H\033[2J{paint(title, NOW, bold=True)}", ""]
    for index in range(centre - AROUND, centre + AROUND + 1):
        if not 0 <= index < len(alignment.lines):
            rows.append("")
            continue
        line = alignment.lines[index]
        art = line_art(line, position_ms) if index == centre else paint(
            line.text, LIT if position_ms >= line.end_ms else DIM)
        pad = max(0, (columns - width_of(line.text)) // 2)
        rows.append(" " * pad + art)
    rows.append("")

    clock = f"{position_ms // 60000}:{position_ms % 60000 // 1000:02d}"
    full = alignment.duration_ms
    bar_width = max(10, min(columns - 16, 60))
    done = 0 if full <= 0 else min(bar_width, round(bar_width * position_ms / full))
    bar = paint("━" * done, NOW) + paint("━" * (bar_width - done), DIM)
    rows.append(f"  {paint(clock, LIT)}  {bar}")
    if now.line is None and now.until_next_ms is not None:
        rows.append(paint(f"  간주 — 다음 줄까지 {now.until_next_ms / 1000:.1f}초", DIM))
    else:
        rows.append("")
    sys.stdout.write("\n".join(rows))
    sys.stdout.flush()


def seconds_of(path: Path) -> float:
    """How long the audio runs.

    @param {Path} path - The audio file.
    @returns {float} Seconds.
    @throws {SystemExit} When ffprobe cannot read it.
    """
    ran = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "json", str(path)], capture_output=True, text=True)
    if ran.returncode != 0:
        sys.exit(f"음원을 못 읽는다: {path}")
    return float(json.loads(ran.stdout)["format"]["duration"])


class Sound:
    """소리를 내면서 **지금 어디인지** 알려 주는 것.

    `sounddevice` 가 있으면 내보낸 표본을 세므로 시계가 밀리지 않는다. 없으면 `ffplay` 를 띄우고
    시계로 센다 — 재생기가 뜨는 만큼 늦으므로 `offset` 으로 맞춘다.
    """

    def __init__(self, path: Path, offset_ms: int) -> None:
        self.offset_ms = offset_ms
        self.started = 0.0
        self.child: subprocess.Popen | None = None
        self.stream = None
        self.frames = 0
        self.rate = 0
        try:
            import soundfile
            import sounddevice
        except ImportError:
            self._by_player(path)
            self.exact = False
            return
        data, self.rate = soundfile.read(str(path), dtype="float32", always_2d=True)
        spot = {"at": 0}

        def feed(out, count, _time, _status):
            """Hand the next block to the device and remember how far we got."""
            piece = data[spot["at"]:spot["at"] + count]
            out[:len(piece)] = piece
            if len(piece) < count:
                out[len(piece):] = 0
            spot["at"] += count
            self.frames = spot["at"]

        self.stream = sounddevice.OutputStream(samplerate=self.rate, channels=data.shape[1], callback=feed)
        self.stream.start()
        self.exact = True

    def _by_player(self, path: Path) -> None:
        """Fall back to an external player and a wall clock.

        @param {Path} path - The audio file.
        @returns {None}
        """
        player = shutil.which("ffplay") or shutil.which("afplay")
        if player is None:
            sys.exit("소리를 낼 수단이 없다. `pip install sounddevice soundfile` 하거나 ffmpeg 을 깔아라.")
        args = [player, "-nodisp", "-autoexit", "-loglevel", "quiet", str(path)] if player.endswith("ffplay") \
            else [player, str(path)]
        self.child = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.started = time.monotonic()

    def where(self) -> int:
        """@returns {int} 지금 재생 자리(ms)."""
        if self.stream is not None:
            return round(self.frames / self.rate * 1000)
        return round((time.monotonic() - self.started) * 1000) - self.offset_ms

    def stop(self) -> None:
        """@returns {None} 소리를 멈춘다."""
        if self.stream is not None:
            self.stream.stop()
            self.stream.close()
        if self.child is not None and self.child.poll() is None:
            self.child.terminate()


def main() -> int:
    """Align the lyrics, then play the song and paint them.

    @returns {int} 0 when it ran to the end.
    """
    ask = argparse.ArgumentParser(description="노래를 틀면서 가사를 글자마다 칠한다")
    ask.add_argument("audio", type=Path, help="음원 파일")
    ask.add_argument("lyrics", type=Path, nargs="?", default=None,
                     help="가사 글 (줄바꿈 그대로). 안 주면 제공처에서 받아 온다")
    ask.add_argument("--artist")
    ask.add_argument("--title")
    ask.add_argument("--isrc")
    ask.add_argument("--mbid")
    ask.add_argument("--language", default=None)
    ask.add_argument("--base-url", default=os.environ.get("MORA_BASE_URL", "https://mora.junx.dev"))
    ask.add_argument("--offset", type=int, default=250,
                     help="바깥 재생기를 쓸 때 그것이 뜨는 데 걸리는 시간(ms)")
    args = ask.parse_args()

    try:
        from mora_lyrics import Mora, NotAligned, Playhead, fetch_lyrics
    except ImportError:
        sys.exit("mora-lyrics 가 없다:  pip install git+https://github.com/aodjo/mora-python")

    if args.lyrics is not None:
        text = args.lyrics.read_text(encoding="utf-8")
    else:
        #: Mora 는 타이밍만 준다. 가사 파일을 안 줬으면 제공처에서 받아 온다.
        if not args.title:
            sys.exit("가사 파일이 없으면 --title 로 곡을 알려 줘야 받아 올 수 있다")
        sys.stderr.write("가사를 찾는 중…\n")
        found = fetch_lyrics(args.title, args.artist, first=True)
        if not found:
            sys.exit("어느 제공처에도 가사가 없다. 파일로 주세요.")
        text = found[0].lyrics
        sys.stderr.write(f"{found[0].provider} 에서 {len(text.splitlines())}줄\n")
    duration_ms = round(seconds_of(args.audio) * 1000)
    mora = Mora(args.base_url)
    try:
        alignment = mora.align(text, isrc=args.isrc, mbid=args.mbid, artist=args.artist,
                               title=args.title, duration_ms=duration_ms, language=args.language)
    except NotAligned as error:
        sys.exit(f"이 곡에는 쓸 수 있는 타이밍이 없다: {error.code}")

    head = Playhead(alignment)
    columns = shutil.get_terminal_size((80, 24)).columns
    title = f"{args.artist or args.isrc or ''} {args.title or ''}".strip() or args.audio.stem
    title = f"{title}   ·   {alignment.tier} {alignment.confidence:.2f}"

    sound = Sound(args.audio, args.offset)
    if not sound.exact:
        title += "   ·   시계로 셈 (--offset 으로 맞추세요)"
    sys.stdout.write("\033[?25l")           # 커서를 숨긴다
    try:
        while True:
            position = sound.where()
            if position > alignment.duration_ms + 3000:
                break
            if sound.child is not None and sound.child.poll() is not None:
                break
            draw(alignment, head, max(0, position), columns, title)
            time.sleep(1 / 30)
    except KeyboardInterrupt:
        pass
    finally:
        sound.stop()
        sys.stdout.write("\033[?25h\033[0m\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
