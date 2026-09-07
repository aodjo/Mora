#!/usr/bin/env python3
"""**받아쓴 낱말 못이 제 줄을 가리키는가.** `settle_heard` 가 쓰는 못(받아쓴 낱말 첫 글자 ↔ 시트 낱말
첫 글자)을 계산해, 밖에서 온 줄 시각과 견준다. 못이 그 줄의 창(줄 시각 − 1 초 ~ 다음 줄 시각 + 1 초)
밖이면 엉뚱한 반복에 짝지어진 것이다.

@example
  MORA_DB=review-mac.db ./.venv/bin/python probe_pins.py 5 1
"""
import difflib
import json
import os
import re
import sqlite3
import sys

sys.path.insert(0, ".")
import align  # noqa: E402

NOT = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")


def tokenize(text: str) -> list[str]:
    """Split a line into the words the aligner uses.

    @param {str} text - One lyric line.
    @returns {list[str]} Words worth aligning.
    """
    return [one for one in text.split() if one and not NOT.match(one)]


def pins_of(lines: list[dict], said: list[tuple[str, int]]) -> dict[tuple[int, int], int]:
    """The same pins `settle_heard` computes.

    @param {list[dict]} lines - Lyric lines.
    @param {list[tuple[str, int]]} said - Heard words with their times.
    @returns {dict[tuple[int, int], int]} (line, word) → time in ms.
    """
    sheet = [(grain, at, spot) for at, line in enumerate(lines)
             for spot, word in enumerate(tokenize(line.get("text", "")))
             for grain in align.grains_of(align.speakable(word))]
    mine, from_mine = align.jamo_of(sheet)
    yours, from_yours = align.jamo_of(said)
    mine_head: dict = {}
    seen = None
    for index, grain in enumerate(from_mine):
        key = sheet[grain][1:]
        if key != seen:
            mine_head[index] = key
            seen = key
    yours_head: dict = {}
    seen = None
    for index, word in enumerate(from_yours):
        if word != seen:
            yours_head[index] = word
            seen = word
    pins: dict = {}
    for a, b, size in difflib.SequenceMatcher(None, mine, yours, autojunk=False).get_matching_blocks():
        if size < align.HEARD_SOLID:
            continue
        for step in range(size):
            key = mine_head.get(a + step)
            word = yours_head.get(b + step)
            if key is not None and word is not None:
                when = said[word][1] + align.HEARD_LEAN_MS
                if key not in pins or when < pins[key]:
                    pins[key] = when
    return pins


def main() -> int:
    """Report, per song, how many pins fall outside their line's window.

    @returns {int} 0 always.
    """
    conn = sqlite3.connect(os.environ.get("MORA_DB", "review.db"))
    conn.row_factory = sqlite3.Row
    for song_id in [int(one) for one in sys.argv[1:]]:
        row = conn.execute("SELECT * FROM songs WHERE id=?", (song_id,)).fetchone()
        lines = json.loads(row["lines"])
        found = align.source_in(align.Path("audio"), row["video_id"])
        heard = align.kept(align.beside(found, ".heard.json"))
        clock = align.kept(align.beside(found, ".clock.json"))
        if not heard or not clock:
            print(f"  [{song_id}] {row['title'][:14]} 산출물 없음 (heard {bool(heard)} clock {bool(clock)})")
            continue
        said = [(word, at) for word, at in heard["낱말"]]
        pins = pins_of(lines, said)
        outside = []
        for (line, spot), when in sorted(pins.items()):
            at = lines[line].get("at")
            if at is None:
                continue
            after = next((one.get("at") for one in lines[line + 1:] if one.get("at") is not None), at + 8000)
            if not (at - 1000 <= when <= after + 1000):
                outside.append((line, spot, when, at))
        print(f"  [{song_id}] {row['title'][:14]:<14} 믿나 {clock.get('받아쓰기를 믿나')} 닮음 {heard.get('닮은 만큼')}"
              f"  못 {len(pins)} · 창 밖 {len(outside)}")
        for line, spot, when, at in outside[:8]:
            print(f"      [{line:>2}] 낱말{spot} 못 {when / 1000:7.1f}  줄 시각 {at / 1000:7.1f}  ({(when - at) / 1000:+.1f}s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
