#!/usr/bin/env python3
"""**언제 몇 줄이 동시에 울린다고 보는가.** 거짓 동시를 찾는다.

화면은 「구간이 지금을 품은 줄」을 전부 켠다. 그 구간은 우리가 맞춘 글자에서 나오는데,
**늘어진 줄이 있으면 그것이 거짓 동시가 된다** — 16 초로 뻗은 줄 하나가 그 사이 모든 줄과
겹쳐 보인다. 사람이 「엉뚱한 곳을 같이 불렀다 한다」고 한 자리다.

시간축을 0.1 초씩 훑으며 몇 줄이 울린다고 보는지 센다. 진짜 이중창은 곡의 일부이므로
「두 줄 이상」이 오래 이어지면 그것은 겹침이 아니라 **구간이 잘못 잡힌 것**이다.
"""
import json
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).parent
STEP = 100


def span(line: dict) -> tuple[int, int] | None:
    chars = [one for word in (line.get("words") or []) for one in (word.get("chars") or [])]
    if not chars:
        return None
    return chars[0]["at"], max(one.get("end") or one["at"] for one in chars)


conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
how_many = int(sys.argv[1]) if len(sys.argv) > 1 else 9

print(f"  {'곡':<28} {'울리는 동안':>10} {'한 줄':>7} {'두 줄':>7} {'셋 이상':>8} {'가장 긴 줄':>10}")
for row in conn.execute("SELECT id,artist,title,lines FROM songs ORDER BY id").fetchall()[:how_many]:
    lines = json.loads(row["lines"])
    spans = [(index, one) for index, one in
             ((i, span(l)) for i, l in enumerate(lines)) if one]
    if not spans:
        continue
    ends = max(one[1][1] for one in spans)

    tally = {0: 0, 1: 0, 2: 0, 3: 0}
    for at in range(0, ends, STEP):
        live = sum(1 for _, (a, b) in spans if a <= at < b)
        tally[min(live, 3)] += 1
    sounding = tally[1] + tally[2] + tally[3]
    longest = max((b - a) / 1000 for _, (a, b) in spans)

    name = f"[{row['id']}] {row['artist'][:8]} — {row['title'][:13]}"
    print(f"  {name:<28} {sounding * STEP / 1000:>9.0f}초 "
          f"{tally[1] / max(sounding, 1) * 100:>6.0f}% {tally[2] / max(sounding, 1) * 100:>6.0f}% "
          f"{tally[3] / max(sounding, 1) * 100:>7.0f}% {longest:>9.1f}초")
