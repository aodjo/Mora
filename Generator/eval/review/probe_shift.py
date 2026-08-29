#!/usr/bin/env python3
"""치우침이 곡마다 다른가, 늘 같은가.

곡마다 다르면 **음원이 달라서**(우리 유튜브 vs 네이버 마스터) 생긴 것이고, 곡을 가리지 않고
비슷하면 **정렬이 늘 늦는 것**이다. 뒤엣것이면 화면에서 글자가 노래보다 늦게 켜져
「숫자는 맞는데 안 맞는 느낌」이 된다 — 그건 상수를 빼서 고칠 수 있다.
"""
import json
import re
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402

NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")


def words_of(text: str) -> list[str]:
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
rows = conn.execute("SELECT id, artist, title, video_id, lines FROM songs ORDER BY id").fetchall()

print(f"{'곡':<34} {'줄':>4} {'치우침':>9} {'뺀 오차':>9} {'p90':>7}")
shifts = []
for row in rows[: int(sys.argv[1]) if len(sys.argv) > 1 else 3]:
    found = align.source_in(HERE / "audio", row["video_id"])
    if not found:
        print(f"{row['artist'][:14]} — {row['title'][:16]:<20} 음원 없음")
        continue
    lines = json.loads(row["lines"])
    got = align.align_song(found, lines, words_of)

    gaps = [one[0]["at"] - lines[i]["at"] for i, one in enumerate(got)
            if one and lines[i].get("at") is not None]
    if not gaps:
        continue
    ranked = sorted(gaps)
    mid = ranked[len(ranked) // 2]
    off = sorted(abs(one - mid) for one in gaps)
    shifts.append(mid)
    name = f"{row['artist'][:12]} — {row['title'][:16]}"
    print(f"{name:<34} {len(gaps):>4} {mid / 1000:>+8.2f}s {off[len(off) // 2]:>7.0f}ms "
          f"{off[int(len(off) * 0.9)]:>6.0f}ms")

if len(shifts) >= 2:
    spread = max(shifts) - min(shifts)
    print(f"\n치우침이 {min(shifts) / 1000:+.2f}s ~ {max(shifts) / 1000:+.2f}s "
          f"로 {spread / 1000:.2f}s 벌어진다")
    print("  → 벌어짐이 작으면 **정렬이 늘 늦는 것**이고 상수로 뺄 수 있다.")
    print("  → 크면 곡마다 음원이 다른 것이라 상수로는 못 고친다.")
