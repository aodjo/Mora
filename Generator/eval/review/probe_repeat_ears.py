"""소리 모델이 「이 창에서 이 가사가 들리나」를 얼마나 갈라 주는지 잰다 — 반복 채우기의 문턱 정하기.

곡마다 시각 있는 줄을 창으로 삼아 두 가지를 잰다. 그 줄의 제 글(맞음)과, 곡 안 다른 줄의 글(틀림).
둘의 분포가 갈리는 자리가 문턱이다.

    MORA_MMS_WEIGHTS=… python probe_repeat_ears.py review.db 11
"""
from __future__ import annotations

import json
import sqlite3
import statistics
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402
from probe_blind import words_of  # noqa: E402

db, count = Path(sys.argv[1]), int(sys.argv[2])
rows = sqlite3.connect(db).execute("SELECT id, title, video_id, lines FROM songs ORDER BY id").fetchall()[:count]
right_all: list[float] = []
wrong_all: list[float] = []
same_all: list[float] = []
other_all: list[float] = []
for song_id, title, video, raw in rows:
    lines = json.loads(raw)
    timed = [(index, one) for index, one in enumerate(lines) if one.get("at") is not None]
    if len(timed) < 8:
        continue
    found = align.source_in(db.parent / "audio", video)
    began = time.time()
    ears = align.repeat_ears(found, words_of)
    if ears is None:
        continue
    listen, alike = ears
    right: list[float] = []
    wrong: list[float] = []
    for place, (index, line) in enumerate(timed[:-1]):
        since, until = line["at"] - 200, timed[place + 1][1]["at"] + 200
        other = timed[(place + len(timed) // 3) % len(timed)][1]["text"]
        if not line["text"].strip() or not other.strip():
            continue
        right.append(listen(line["text"], since, until))
        wrong.append(listen(other, since, until))
    right_all.extend(right)
    wrong_all.extend(wrong)
    #: 같은 글 줄끼리(진짜 반복)와 다른 글 줄끼리 — 소리가 얼마나 닮았나.
    windows = [(index, line["at"] - 200, timed[place + 1][1]["at"] + 200) for place, (index, line) in enumerate(timed[:-1])]
    letters = {index: "".join(ch for ch in lines[index]["text"] if ch.isalnum()) for index, _, _ in windows}
    same = [(a, b) for i, a in enumerate(windows) for b in windows[i + 1:]
            if letters[a[0]] and letters[a[0]] == letters[b[0]]]
    other = [(a, b) for i, a in enumerate(windows) for b in windows[i + 1:i + 2]
             if letters[a[0]] and letters[b[0]] and letters[a[0]] != letters[b[0]]]
    song_same = [alike((a[1], a[2]), (b[1], b[2])) for a, b in same[:40]]
    song_other = [alike((a[1], a[2]), (b[1], b[2])) for a, b in other[:40]]
    same_all.extend(song_same)
    other_all.extend(song_other)
    if song_same:
        print(f"      닮은꼴: 같은 글 {len(song_same)}쌍 가운데 {statistics.median(song_same):.2f} · "
              f"다른 글 {len(song_other)}쌍 가운데 {statistics.median(song_other) if song_other else float('nan'):.2f}")
    print(f"[{song_id}] {title[:18]:<18} 맞음 가운데 {statistics.median(right):.2f} (아래 4분위 {sorted(right)[len(right) // 4]:.2f}) · "
          f"틀림 가운데 {statistics.median(wrong):.2f} (위 4분위 {sorted(wrong)[len(wrong) * 3 // 4]:.2f}) · {time.time() - began:.0f}초", flush=True)
for name, got in (("맞음", right_all), ("틀림", wrong_all)):
    got.sort()
    print(f"{name} {len(got)}줄: 가운데 {statistics.median(got):.2f} · 10% {got[len(got) // 10]:.2f} · "
          f"25% {got[len(got) // 4]:.2f} · 75% {got[len(got) * 3 // 4]:.2f} · 90% {got[len(got) * 9 // 10]:.2f}")
for name, got in (("닮은꼴 같은 글", same_all), ("닮은꼴 다른 글", other_all)):
    if got:
        got.sort()
        print(f"{name} {len(got)}쌍: 가운데 {statistics.median(got):.2f} · 10% {got[len(got) // 10]:.2f} · "
              f"25% {got[len(got) // 4]:.2f} · 75% {got[len(got) * 3 // 4]:.2f}")
for cut in (0.5, 0.6, 0.7, 0.8):
    keep = sum(1 for one in same_all if one >= cut) / max(1, len(same_all))
    pass_ = sum(1 for one in other_all if one >= cut) / max(1, len(other_all))
    print(f"  닮은꼴 문턱 {cut}: 같은 글 통과 {keep * 100:.0f}% · 다른 글 통과 {pass_ * 100:.0f}%")
for cut in (0.3, 0.4, 0.5, 0.6, 0.7):
    keep = sum(1 for one in right_all if one >= cut) / max(1, len(right_all))
    pass_ = sum(1 for one in wrong_all if one >= cut) / max(1, len(wrong_all))
    print(f"  문턱 {cut}: 맞음 통과 {keep * 100:.0f}% · 틀림 통과 {pass_ * 100:.0f}%")
