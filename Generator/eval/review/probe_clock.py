#!/usr/bin/env python3
"""**곡이 밖의 시계와 얼마나 물려 있는가, 그 안에서 튀는 줄은 몇인가.**

밖에서 온 줄 시각으로 우리 실수를 재는 것은 오래 물려 둔 자다 — 크게 어긋난 열다섯 줄을
소리로 대질하니 밖의 자리가 나은 것은 하나뿐이었고, 음원 판이 다르면 곡이 통째로 밀린다.

여기서 재는 것은 다르다. 판이 다르면 **모든 줄이 함께** 밀리므로, 곡마다 「가운뎃값에서
얼마나 흩어져 있는가」를 먼저 본다. 흩어짐이 좁은 곡은 같은 음원이라는 뜻이고, 그 곡 안에서
혼자 몇 초씩 떨어져 있는 줄은 판 차이로 설명이 안 된다.

찍는 것: 곡마다 가운뎃값·흩어짐, 그리고 시계가 좁은 곡에서 `CLOCK_APART_MS` 보다 멀리
떨어진 줄.
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
    """Split a line into the words the aligner uses, dropping marks that carry no sound.

    @param {str} text - One lyric line.
    @returns {list[str]} Words worth aligning.
    """
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


if "--off" in sys.argv:
    align.settle_clock = lambda *a, **k: None
    print("  시계 되돌리기 끔 — 견줄 바탕\n")

conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
rows = conn.execute("SELECT id, artist, title, video_id, lines FROM songs ORDER BY id").fetchall()
how_many = int([one for one in sys.argv[1:] if one.isdigit()][0]) \
    if [one for one in sys.argv[1:] if one.isdigit()] else 9

far = total = 0
for row in rows[:how_many]:
    found = align.source_in(HERE / "audio", row["video_id"])
    if not found:
        continue
    lines = json.loads(row["lines"])
    out = align.align_song(found, lines, words_of)

    off = []
    for index, words in enumerate(out):
        chars = [one for word in words for one in (word.get("chars") or [])]
        if chars and lines[index].get("at") is not None:
            off.append((index, chars[0]["at"] - lines[index]["at"]))
    if len(off) < align.CLOCK_LEAST:
        print(f"  [{row['id']}] {row['artist'][:12]:<14} — {row['title'][:22]:<24} 시각 있는 줄이 모자람")
        continue
    mid = sorted(one for _, one in off)[len(off) // 2]
    apart = sorted(abs(one - mid) for _, one in off)
    spread = apart[len(apart) // 2]
    stray = [(index, one - mid) for index, one in off if abs(one - mid) > align.CLOCK_APART_MS]

    tight = spread <= align.CLOCK_TIGHT_MS
    total += len(off)
    if tight:
        far += len(stray)
    print(f"  [{row['id']}] {row['artist'][:12]:<14} — {row['title'][:22]:<24} "
          f"가운뎃값 {mid / 1000:+6.2f}s · 흩어짐 {spread / 1000:5.2f}s "
          f"{'좁음' if tight else '넓음'} · 튀는 줄 {len(stray):>2}")
    for index, one in stray[:5]:
        print(f"        {index:>3}번 {one / 1000:+6.2f}s  {lines[index]['text'][:36]}")

print(f"\n  시계가 좁은 곡에서 튀는 줄 {far} (줄 {total})")
