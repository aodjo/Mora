#!/usr/bin/env python3
"""**밑그림은 맞는데 결과가 왜 흩어지나.** 줄마다 셋을 나란히 놓는다.

하치와레girl 은 앞머리 중얼거림을 걷어내고 나서 통째로 밀리던 것이 없어졌다(-13.41 → +1.24 초).
그런데 아직 헐겁다 — 폭 17 초, 줄의 5분의 1만 제자리다. 밑그림이 옳은데 결과가 흩어진다면
어긋나는 곳은 밑그림이 아니라 그 뒤의 정렬이다.

그래서 줄마다 **진짜 시각 · 밑그림(닻) · 나온 값**을 나란히 놓는다. 밑그림은 맞는데 나온 값만
어긋난 줄이 있으면 정렬이 밑그림을 안 듣는 것이고, 밑그림부터 어긋난 줄이 있으면 닻이 거기까지는
못 미친 것이다. 둘은 고치는 자리가 다르다.

@example
  python probe_drift.py 11
"""
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402

NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")
#: 이 안이면 제자리로 친다(ms).
NEAR_MS = 500


def words_of(text: str) -> list[str]:
    """Split a line into the words the aligner uses, dropping marks that carry no sound.

    @param {str} text - One lyric line.
    @returns {list[str]} Words worth aligning.
    """
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def main() -> int:
    """Print the sheet's time, the invented clock and the aligned time for every line.

    @returns {int} 0 always.
    """
    which = int(sys.argv[1]) if len(sys.argv) > 1 else 11
    conn = sqlite3.connect(HERE / os.environ.get("MORA_DB", "review.db"))
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM songs WHERE id=?", (which,)).fetchone()
    lines = json.loads(row["lines"])
    found = align.source_in(HERE / "audio", row["video_id"])
    blind = [{**one, "at": None} for one in lines]

    clock = align.heard_clock(found, blind, words_of)
    out, _ = align.align_voices(found, blind, words_of, row["title"])

    print(f"  [{which}] {row['title']}  ·  {len(lines)}줄\n")
    print(f"  {'':>3} {'진짜':>8} {'밑그림':>8} {'나온값':>8} {'밑그림차':>9} {'나온차':>8}  가사")
    rows: list[tuple[int, int]] = []
    for at, line in enumerate(lines):
        real = line.get("at")
        drew = clock[at] if clock else None
        chars = [one for word in out[at] for one in (word.get("chars") or [])
                 if one.get("at") is not None] if at < len(out) else []
        got = chars[0]["at"] if chars else None
        if real is None:
            continue
        a = (drew - real) if drew is not None else None
        b = (got - real) if got is not None else None
        if a is not None and b is not None:
            rows.append((a, b))
        mark = "  " if b is not None and abs(b) <= NEAR_MS else "←"
        print(f"  {at:>3} {real / 1000:7.2f}s {drew / 1000 if drew is not None else -1:7.2f}s "
              f"{got / 1000 if got is not None else -1:7.2f}s "
              f"{a / 1000 if a is not None else 0:+8.2f}s {b / 1000 if b is not None else 0:+7.2f}s "
              f"{mark} {line.get('text', '')[:30]}")

    if rows:
        for name, at in (("밑그림", 0), ("나온값", 1)):
            gaps = sorted(abs(one[at]) for one in rows)
            mid = sorted(one[at] for one in rows)[len(rows) // 2]
            near = sum(1 for one in rows if abs(one[at] - mid) <= NEAR_MS)
            print(f"\n  {name}  가운뎃값 {mid / 1000:+.2f}s · 가운뎃값에서 0.5초 안 "
                  f"{near}/{len(rows)} ({near / len(rows) * 100:.0f}%) · "
                  f"어긋남 가운뎃값 {gaps[len(gaps) // 2] / 1000:.2f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
