#!/usr/bin/env python3
"""**밖에서 온 시각에 기대지 않고** 무너진 줄을 센다.

판정은 `align.flag_stuck` 이 한다 — 여기서 따로 짜지 않는다. 앞판은 같은 규칙을 probe 안에
베껴 두었다가 `align.py` 만 고치고 probe 는 안 고쳐, **재는 것과 내보내는 것이 달라졌다.**
짧은 줄을 속도로 재던 옛 규칙이 여기 남아 「나빠졌다」는 거짓 신호를 냈다.

왜 이 자가 필요한가. 「밖에서 온 줄 시각과 얼마나 다른가」로는 못 잰다 — 크게 어긋난
열다섯 줄을 소리로 대질하니 바이브 자리가 나은 것은 하나뿐이었다. 음원 판이 다르면 곡이
통째로 어긋나므로 그 자로는 우리 실수와 판 차이를 못 가른다. 이 자는 **정렬 결과 안의
모순**만 보므로 판이 달라도 흔들리지 않는다.
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


# `--off` 를 주면 2 차 되짚기를 끄고 잰다. 견줄 바탕을 만드는 유일한 방법이라 여기 둔다 —
# 밖에서 코드를 갈아 끼우면 `__file__` 같은 것이 없어 probe 가 안 돈다.
if "--off" in sys.argv:
    align.rethink = lambda *a, **k: []
    print("2 차 되짚기 끔 — 견줄 바탕\n")


conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
rows = conn.execute("SELECT id, artist, title, video_id, lines FROM songs ORDER BY id").fetchall()
how_many = int(sys.argv[1]) if len(sys.argv) > 1 else 8

total = hit = 0
for row in rows[:how_many]:
    found = align.source_in(HERE / "audio", row["video_id"])
    if not found:
        continue
    lines = json.loads(row["lines"])
    got = align.align_song(found, lines, words_of)
    stuck = [(index, one[0]["stuck"]) for index, one in enumerate(got)
             if one and one[0].get("stuck")]

    # 겹침은 따로 센다. `flag_stuck` 은 겹침을 표로 안 내보내지만(사람에게는 길이·틈이
    # 읽히기 쉽다) 두 줄이 같은 소리에 포개진 것은 가장 뚜렷한 무너짐이다.
    over = 0
    ends = []
    for one in got:
        chars = [c for word in one for c in (word.get("chars") or [])]
        ends.append((chars[0]["at"], chars[-1]["at"]) if chars else None)
    for before, now in zip(ends, ends[1:]):
        if before and now and now[0] < before[1]:
            over += 1

    total += len(lines)
    hit += len(stuck)
    print(f"  [{row['id']}] {row['artist'][:12]:<14} — {row['title'][:22]:<24} "
          f"줄 {len(lines):>3} · 무너짐 {len(stuck):>2} · 겹친 자리 {over:>2}")
    for index, why in stuck[:4]:
        at = got[index][0]["at"] / 1000
        print(f"        {index:>3}번 {at:>7.2f}s  {lines[index]['text'][:24]:<26} {why}")

print(f"\n  줄 {total} · 무너짐 {hit} ({hit * 100 // max(1, total)}%)")
