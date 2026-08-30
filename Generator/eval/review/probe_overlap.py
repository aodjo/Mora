#!/usr/bin/env python3
"""**줄이 시간상 겹치는가.** 겹치면 화면이 어느 줄을 켤지 정할 수가 없다.

목소리를 가르기 전에는 줄이 차례대로 왔으므로 「지금 시각보다 앞선 마지막 줄」이 곧 지금
줄이었다. 레인이 생기면서 그 전제가 깨졌다 — 백보컬은 리드와 **같은 때에** 불린다.

겹치는 자리에서 화면은 뒤엣것을 고른다. 그래서 리드를 부르는 동안 백보컬 줄이 켜지고,
사람은 「줄을 잘못 잡았다」로 본다.

여기서는 얼마나 겹치는지, 겹칠 때 어느 레인끼리인지를 센다.
"""
import json
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).parent


def span(line: dict) -> tuple[int, int] | None:
    """그 줄이 실제로 차지하는 구간. 맞춘 글자가 있어야 뜻이 있다."""
    chars = [one for word in (line.get("words") or []) for one in (word.get("chars") or [])]
    if not chars:
        return None
    return chars[0]["at"], max(one.get("end") or one["at"] for one in chars)


conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
how_many = int(sys.argv[1]) if len(sys.argv) > 1 else 9

print(f"  {'곡':<30} {'줄':>4} {'겹침':>5} {'레인 다름':>9} {'뒤집힘':>7}  보기")
for row in conn.execute("SELECT id, artist, title, lines FROM songs ORDER BY id").fetchall()[:how_many]:
    lines = json.loads(row["lines"])
    spans = [(index, span(one), one.get("lane", 0) or 0) for index, one in enumerate(lines)]
    spans = [one for one in spans if one[1]]

    both = cross = 0
    tales = []
    for (a, (a0, a1), la), (b, (b0, b1), lb) in zip(spans, spans[1:]):
        if b0 < a1:
            both += 1
            if la != lb:
                cross += 1
                if len(tales) < 3:
                    tales.append(f"{a}({la})↔{b}({lb}) {(a1 - b0) / 1000:.1f}초")
    #: **차례가 뒤집힌 줄.** 뒷줄이 앞줄보다 먼저 시작하면 화면이 앞뒤로 튄다 — 지금 줄을
    #: 「시각이 지난 마지막 줄」로 고르기 때문이다. 겹침보다 이쪽이 훨씬 나쁘다.
    back = [(a, b, (a0 - b0) / 1000)
            for (a, (a0, _), _), (b, (b0, _), _) in zip(spans, spans[1:]) if b0 < a0]

    name = f"[{row['id']}] {row['artist'][:9]} — {row['title'][:14]}"
    print(f"  {name:<30} {len(lines):>4} {both:>7} {cross:>13} {len(back):>7}  "
          + " · ".join(f"{a}→{b} {gap:.1f}초" for a, b, gap in back[:3]))
