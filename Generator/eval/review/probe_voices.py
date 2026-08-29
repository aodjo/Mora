#!/usr/bin/env python3
"""보컬을 리드/서브로 가른 뒤 맞춘 것이 **한 갈래로 맞춘 것보다 나은가.**

자는 밖에서 온 줄 시각이 아니다 — 크게 어긋난 열다섯 줄을 소리로 대질하니 바이브 자리가
나은 것은 하나뿐이었다. 음원 판이 다르면 곡이 통째로 어긋나므로 그 자로는 못 가른다.

**정렬 결과 안의 모순**을 센다(`align.flag_stuck`). 겹침도 따로 센다 — 두 줄이 같은 소리에
포개진 것이 이번에 고치려는 바로 그것이라서다.

    probe_voices.py 파란달팽이
"""
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402

NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")


def words_of(text: str) -> list[str]:
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def look(got) -> tuple[int, int, list[str]]:
    """무너진 줄 수, 겹친 자리 수, 까닭들."""
    stuck = [(i, one[0]["stuck"]) for i, one in enumerate(got) if one and one[0].get("stuck")]
    ends = []
    for one in got:
        chars = [c for word in one for c in (word.get("chars") or [])]
        ends.append((chars[0]["at"], chars[-1]["at"]) if chars else None)
    over = sum(1 for a, b in zip(ends, ends[1:]) if a and b and b[0] < a[1])
    return len(stuck), over, [f"{i}번 {why}" for i, why in stuck]


want = sys.argv[1] if len(sys.argv) > 1 else "파란달팽이"
conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
row = conn.execute(
    "SELECT id, artist, title, video_id, lines FROM songs WHERE title LIKE ? OR artist LIKE ?",
    (f"%{want}%", f"%{want}%")).fetchone()
if row is None:
    raise SystemExit(f"{want!r} 로 찾히는 곡이 없다")
found = align.source_in(HERE / "audio", row["video_id"])
if not found:
    raise SystemExit("음원이 없다")
lines = json.loads(row["lines"])
print(f"[{row['id']}] {row['artist']} — {row['title']} · 줄 {len(lines)}\n")

began = time.time()
one_way = align.align_song(found, lines, words_of)
stuck1, over1, why1 = look(one_way)
print(f"  한 갈래  {time.time() - began:>5.0f}초 · 무너짐 {stuck1:>2} · 겹친 자리 {over1:>2}")

began = time.time()
two_way, lanes = align.align_voices(found, lines, words_of)
stuck2, over2, why2 = look(two_way)
subs = sum(1 for one in lanes.values() if one == 1)
print(f"  두 갈래  {time.time() - began:>5.0f}초 · 무너짐 {stuck2:>2} · 겹친 자리 {over2:>2} · 서브로 간 줄 {subs}")

print("\n  서브로 간 줄")
for index, lane in sorted(lanes.items()):
    if lane != 1:
        continue
    at = two_way[index][0]["at"] / 1000 if two_way[index] else -1
    print(f"    {index:>3}번 {at:>7.2f}s  {lines[index]['text'][:44]}")

for name, why in (("한 갈래", why1), ("두 갈래", why2)):
    print(f"\n  {name} 에서 무너진 줄")
    for one in why[:6]:
        print(f"    {one}")
