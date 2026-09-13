#!/usr/bin/env python3
"""**두 목소리 구간에서 어느 시계가 무엇을 골랐나.** 한 곡의 줄 구간마다 시트 시각 · 받아쓰기 시계 · 모델 시계 ·
고른 시계(`our_clock`) · 최종 줄 머리 · 레인을 찍고, 화자 가르기가 두 목소리를 듣는 구간 안인지 표시한다.
시각은 모두 초, 최종 줄 머리의 차는 곡 어긋남(가운데값)을 뺀 값이다.

@example
  MORA_MMS_WEIGHTS=~/mora-probe/mms_sing_b.pt .venv/bin/python probe_chorus.py 10 80 98
"""
import json
import os
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402
from probe_blind import starts, words_of  # noqa: E402


def seconds(ms: int | None) -> str:
    """Write a time in seconds, or a dash when there is none.

    @param {int | None} ms - A time in milliseconds.
    @returns {str} For example ` 203.9`.
    """
    return f"{ms / 1000:6.1f}" if ms is not None else "     -"


def main() -> int:
    """Print the clocks of one song over a line range.

    @returns {int} 0 always.
    """
    song_id, lo, hi = (int(one) for one in sys.argv[1:4])
    conn = sqlite3.connect(HERE / os.environ.get("MORA_DB", "review.db"))
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT id, title, video_id, lines FROM songs WHERE id = ?", (song_id,)).fetchone()
    found = align.source_in(HERE / "audio", row["video_id"])
    lines = json.loads(row["lines"])
    blind = [{**one, "at": None} for one in lines]
    heard = align.heard_clock(found, blind, words_of) or [None] * len(lines)
    model = align.model_clock(found, blind, words_of) or [None] * len(lines)
    chosen = align.our_clock(found, blind, words_of) or [None] * len(lines)
    together = align.sung_together(align.voices_apart(found), align.TOGETHER_LEAST_MS)
    out, lanes = align.align_voices(found, blind, words_of, row["title"])
    final = starts(out)
    gaps = sorted(final[index] - one["at"] for index, one in enumerate(lines) if index in final and one.get("at") is not None)
    middle = gaps[len(gaps) // 2] if gaps else 0

    print(f"== [{song_id}] {row['title']} · 곡 어긋남 {middle / 1000:+.2f}초 · 두 목소리 구간 "
          + " ".join(f"{a / 1000:.1f}~{b / 1000:.1f}" for a, b in together))
    print(f"  {'줄':>4} {'시트':>6} {'받아쓰기':>7} {'모델':>6} {'고른':>6} {'최종':>6} {'차':>6} 레인  가사")
    for index in range(lo, min(hi, len(lines) - 1) + 1):
        sheet = lines[index].get("at")
        ours = final.get(index)
        off = f"{(ours - sheet - middle) / 1000:+6.2f}" if ours is not None and sheet is not None else "     -"
        inside = any(a <= (sheet or -1) <= b for a, b in together)
        print(f"  {index:>4} {seconds(sheet)} {seconds(heard[index])}  {seconds(model[index])} {seconds(chosen[index])}"
              f" {seconds(ours)} {off} {lanes.get(index, 0):>3}{'◆' if inside else ' '} {lines[index].get('text', '')[:24]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
