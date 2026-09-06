#!/usr/bin/env python3
"""**받아쓴 시각이 한쪽으로 쏠려 있나.** 짝지어진 낱말을 진짜 줄 시각과 견준다.

작업실에 받아쓴 것을 펴 놓고 보니 소리보다 앞서 보인다는 말이 나왔다. 그렇다면 닻이 통째로 앞당겨
서고, 시계도 밑그림도 함께 앞당겨진다 — 눈에 보이는 것보다 큰 문제다.

재는 법은 하나다. 짝이 맞은 자리마다 「그 음절이 든 줄의 진짜 시작」과 「그 낱말이 들린 시각」을
견준다. 줄 안에서 몇 번째 음절인지는 모르므로 낱낱은 흔들리지만, **줄의 첫 음절만** 보면 둘은
같은 것을 가리켜야 한다. 그 차이의 가운뎃값이 쏠림이다.

@example
  python probe_lean.py
"""
import difflib
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


def words_of(text: str) -> list[str]:
    """Split a line into the words the aligner uses, dropping marks that carry no sound.

    @param {str} text - One lyric line.
    @returns {list[str]} Words worth aligning.
    """
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def main() -> int:
    """Print, per song, how far the transcript's times sit from the sheet's own.

    @returns {int} 0 always.
    """
    conn = sqlite3.connect(HERE / os.environ.get("MORA_DB", "review.db"))
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM songs ORDER BY id").fetchall()
    print(f"  {'곡':<22} {'줄':>5} {'쏠림':>9} {'흩어짐':>8}")
    every: list[int] = []

    for row in rows:
        got = HERE / "audio" / f"{row['video_id']}.heard.json"
        if not got.exists():
            continue
        said = [(one, at) for one, at in json.loads(got.read_text(encoding="utf-8")).get("낱말", [])]
        lines = json.loads(row["lines"])
        sheet: list[tuple[str, int]] = []
        for at, line in enumerate(lines):
            for word in words_of(line.get("text", "")):
                for grain in align.grains_of(align.speakable(word)):
                    sheet.append((grain, at))
        if not said or not sheet:
            continue

        #: 줄이 시작하는 음절 자리.
        starts: dict[int, int] = {}
        for grain, (_, line) in enumerate(sheet):
            starts.setdefault(line, grain)

        mine, from_mine = align.jamo_of(sheet)
        yours, from_yours = align.jamo_of(said)
        first: dict[int, int] = {}
        for a, b, size in difflib.SequenceMatcher(None, mine, yours, autojunk=False).get_matching_blocks():
            if size < align.HEARD_SOLID:
                continue
            for step in range(size):
                grain = from_mine[a + step]
                when = said[from_yours[b + step]][1]
                if grain not in first or when < first[grain]:
                    first[grain] = when

        #: 줄의 **첫** 음절이 짝지어진 줄만 본다. 그때 둘은 같은 것을 가리킨다.
        off = [first[starts[line]] - lines[line]["at"]
               for line in starts
               if starts[line] in first and lines[line].get("at") is not None]
        if len(off) < 4:
            continue
        every.extend(off)
        off.sort()
        mid = off[len(off) // 2]
        apart = sorted(abs(one - mid) for one in off)
        print(f"  [{row['id']:>2}] {row['title'][:16]:<18} {len(off):>5} {mid / 1000:+8.2f}s "
              f"{apart[len(apart) // 2] / 1000:7.2f}s")

    if every:
        every.sort()
        mid = every[len(every) // 2]
        apart = sorted(abs(one - mid) for one in every)
        print(f"\n  통틀어 {len(every)}줄 · 쏠림 가운뎃값 {mid / 1000:+.2f}s · "
              f"흩어짐 {apart[len(apart) // 2] / 1000:.2f}s")
        print(f"  앞선 줄 {sum(1 for one in every if one < 0)} · 늦은 줄 {sum(1 for one in every if one > 0)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
