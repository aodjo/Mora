#!/usr/bin/env python3
"""**시계의 진짜 못.** `heard_clock` 이 받아쓰기에서 줄 첫 낱알을 실제로 짝지은 줄(못)과 그 시각을,
시트 시각·고른 짐작과 나란히 찍는다. `.clock.json` 의 「못박힌 줄」은 보간된 줄까지 포함해서 못과
보간을 못 가른다 — 여기서는 `heard_clock` 과 같은 계산을 되풀이해 못만 골라낸다.

@example
  MORA_DB=review-mac.db ./.venv/bin/python probe_clockpins.py 10 60 99
"""
import difflib
import json
import os
import sqlite3
import sys

sys.path.insert(0, ".")
import align  # noqa: E402
from probe_pins import tokenize  # noqa: E402


def main() -> int:
    """Print the pins of one song over a line range.

    @returns {int} 0 always.
    """
    conn = sqlite3.connect(os.environ.get("MORA_DB", "review.db"))
    conn.row_factory = sqlite3.Row
    song_id, lo, hi = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
    row = conn.execute("SELECT * FROM songs WHERE id=?", (song_id,)).fetchone()
    lines = json.loads(row["lines"])
    found = align.source_in(align.Path("audio"), row["video_id"])
    blind = [{**one, "at": None} for one in lines]
    coarse = align.guess_clock(found, blind, tokenize) or [None] * len(lines)
    sheet = [(grain, at) for at, line in enumerate(lines)
             for word in tokenize(line.get("text", "")) for grain in align.grains_of(align.speakable(word))]
    mine, from_mine = align.jamo_of(sheet)
    said, alike = align.best_heard(found, mine, blind, tokenize)
    yours, from_yours = align.jamo_of(said)
    marks: dict[int, int] = {}
    for a, b, size in difflib.SequenceMatcher(None, mine, yours, autojunk=False).get_matching_blocks():
        if size < align.HEARD_SOLID:
            continue
        for step in range(size):
            grain = from_mine[a + step]
            when = said[from_yours[b + step]][1]
            if grain not in marks or when < marks[grain]:
                marks[grain] = when
    starts: list = [None] * len(lines)
    for grain, (_, line) in enumerate(sheet):
        if starts[line] is None:
            starts[line] = grain
    pairs = []
    for grain in sorted(marks):
        if not pairs or marks[grain] >= pairs[-1][1]:
            pairs.append((grain, marks[grain]))
    pin_at = {}
    for grain, when in pairs:
        line = sheet[grain][1]
        if starts[line] == grain:
            pin_at[line] = when
    dropped = {sheet[g][1] for g in marks if starts[sheet[g][1]] == g} - set(pin_at)
    print(f"  [{song_id}] {row['title'][:16]} 닮음 {alike:.2f} · 못(차례 지킴) {len(pin_at)} · 차례로 버림 {len(dropped)}")
    for index in range(lo, hi + 1):
        at = lines[index].get("at")
        pin = pin_at.get(index)
        heard_word = ""
        if pin is not None:
            near = [w for w, t in said if abs(t - pin) <= 10]
            heard_word = near[0] if near else ""
        print(f"  [{index:>2}] 시트 {(at or 0) / 1000:6.1f}  짐작 {(coarse[index] or 0) / 1000:6.1f}  "
              f"못 {(pin / 1000) if pin is not None else '   —  ':>6} {heard_word:<8} "
              f"{'(차례로 버림)' if index in dropped else '':<8} {lines[index]['text'][:22]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
