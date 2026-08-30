#!/usr/bin/env python3
"""**지금 저장된 것이 무엇인가.** 곡마다 레인 나눔과 무너진 줄을 한눈에 본다.

맞추기를 돌린 뒤 「정말 그렇게 저장됐나」를 보는 자리다. 서버가 저장한 것과 probe 가 잰 것이
달라 한참 헤맨 적이 있어(원본 고르기가 파생 파일을 집던 때) 저장된 쪽을 직접 읽는다.
"""
import json
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).parent
conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row

print(f"  {'곡':<30} {'줄':>4} {'갈래':>4} {'무너짐':>6}  나눔")
for row in conn.execute("SELECT id, artist, title, lines FROM songs ORDER BY id"):
    lines = json.loads(row["lines"])
    tally: dict[int, int] = {}
    for one in lines:
        lane = one.get("lane", 0) or 0
        tally[lane] = tally.get(lane, 0) + 1
    stuck = sum(1 for one in lines if (one.get("words") or [{}])[0].get("stuck"))
    name = f"[{row['id']}] {row['artist'][:9]} — {row['title'][:14]}"
    print(f"  {name:<30} {len(lines):>4} {len(tally):>4} {stuck:>6}  {dict(sorted(tally.items()))}")
