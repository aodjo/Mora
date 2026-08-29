#!/usr/bin/env python3
"""저장된 값을 그대로 본다. 프로브와 화면이 다르면 여기가 갈림길이다."""
import json
import sqlite3
import sys
from pathlib import Path

song_id = int(sys.argv[1]) if len(sys.argv) > 1 else 2
want = sys.argv[2] if len(sys.argv) > 2 else None

conn = sqlite3.connect(Path(__file__).parent / "review.db")
conn.row_factory = sqlite3.Row
row = conn.execute("SELECT artist, title, lines FROM songs WHERE id=?", (song_id,)).fetchone()
if row is None:
    raise SystemExit(f"{song_id}번 곡이 없다")
lines = json.loads(row["lines"])
print(f"{row['artist']} — {row['title']} · 줄 {len(lines)}")

for index, line in enumerate(lines):
    text = line.get("text", "")
    if want and want not in text:
        continue
    words = line.get("words") or []
    # 화면이 기대하는 어절 수와 저장된 어절 수가 맞는가. 어긋나면 그 줄이 통째로 어긋난다.
    expect = [one for one in text.split() if one]
    flag = "" if len(words) == len(expect) else f"  ★ 화면은 {len(expect)}개를 기대"
    print(f"\n[{index}] {text[:40]}  → 저장 {len(words)}개{flag}")
    for one in words:
        chars = one.get("chars") or []
        made = "".join(c.get("text", "") for c in chars)
        print(f"   {one.get('text')!r} at={one.get('at')} end={one.get('end')} "
              f"chars={len(chars)} 이어붙이면={made!r}")
        for c in chars:
            print(f"       {c.get('text')} at={c.get('at')} end={c.get('end')} "
                  f"sure={c.get('sure')} shaky={c.get('shaky', False)}")
    if want:
        break
