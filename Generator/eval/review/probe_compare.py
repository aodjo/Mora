#!/usr/bin/env python3
"""2 차 되짚기가 **고친 것보다 망가뜨린 것이 많지 않은가.**

「밖에서 온 시각과의 어긋남」만으로는 못 본다. 우리가 옮긴 줄은 정의상 밖에서 온 시각 쪽으로
가니 그 지표는 언제나 좋아진다 — 순환이다. 진짜 물어야 할 것은 둘이다:

1. **옮긴 줄이 몇 개이고 그 근거가 얼마나 셌나.**
2. **안 옮긴 줄이 덩달아 움직였나.** 못을 박으면 그 자리에서 정렬을 가르므로, 못 옆의
   줄들이 다시 맞춰진다. 그때 나빠지는 줄이 있으면 그게 이 방식의 값이다.

문턱(`EVIDENCE`)을 여러 개 훑어 고친 줄과 망가뜨린 줄을 나란히 센다.
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
MOVED_MS = 100      # 이만큼 넘게 움직였으면 「움직였다」고 본다


def words_of(text: str) -> list[str]:
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def starts(got, lines):
    """줄마다 첫 글자의 시각. 못 맞춘 줄은 None."""
    return [one[0]["at"] if one else None for one in got]


def offs(got, lines):
    """밖에서 온 시각과의 어긋남. 곡 전체 치우침은 뺀다."""
    pairs = [(i, one) for i, one in enumerate(got) if one and lines[i].get("at") is not None]
    if not pairs:
        return {}
    bias = sorted(one[0]["at"] - lines[i]["at"] for i, one in pairs)[len(pairs) // 2]
    return {i: one[0]["at"] - lines[i]["at"] - bias for i, one in pairs}


how_many = int(sys.argv[1]) if len(sys.argv) > 1 else 8
thresholds = [float(one) for one in sys.argv[2:]] or [0.5, 1.0, 2.0]

conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
songs = []
for row in conn.execute("SELECT id, artist, title, video_id, lines FROM songs ORDER BY id").fetchall()[:how_many]:
    found = align.source_in(HERE / "audio", row["video_id"])
    if found:
        songs.append((row, found, json.loads(row["lines"])))

# 끄고 한 번. 이것이 견줄 바탕이다.
real_rethink = align.rethink
align.rethink = lambda *a, **k: []
base = {}
for row, path, lines in songs:
    got = align.align_song(path, lines, words_of)
    base[row["id"]] = (starts(got, lines), offs(got, lines))
align.rethink = real_rethink
print(f"바탕 — 곡 {len(songs)} · 2 차 되짚기 끔\n")

print(f"{'문턱':>5} {'옮긴 줄':>7} {'고침':>6} {'망가뜨림':>8} {'덩달아 움직인 줄':>16} {'그중 나빠짐':>11}")
for mark in thresholds:
    align.EVIDENCE = mark
    fixed = broke = nudged = nudged_bad = moved = 0
    tales = []
    for row, path, lines in songs:
        got = align.align_song(path, lines, words_of)
        now_starts, now_offs = starts(got, lines), offs(got, lines)
        was_starts, was_offs = base[row["id"]]
        for index in range(len(lines)):
            a, b = was_starts[index], now_starts[index]
            if a is None or b is None or index not in was_offs or index not in now_offs:
                continue
            if abs(a - b) <= MOVED_MS:
                continue
            before, after = abs(was_offs[index]), abs(now_offs[index])
            # 크게 옮겨졌으면 그건 못을 박은 줄이고, 조금이면 덩달아 움직인 줄이다.
            if abs(a - b) > 500:
                moved += 1
                if after < before - 100:
                    fixed += 1
                    tales.append((row["id"], index, before, after, "고침"))
                elif after > before + 100:
                    broke += 1
                    tales.append((row["id"], index, before, after, "망가뜨림"))
            else:
                nudged += 1
                if after > before + 100:
                    nudged_bad += 1
    print(f"{mark:>5.1f} {moved:>7} {fixed:>6} {broke:>8} {nudged:>16} {nudged_bad:>11}")
    for sid, index, before, after, what in tales[:6]:
        print(f"        [{sid}] {index:>3}번  {before:>6.0f}ms → {after:>6.0f}ms  {what}")
