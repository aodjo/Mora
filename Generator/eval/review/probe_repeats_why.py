"""반복 채우기가 한 곡에서 무엇을 넣었는지, 그 자리의 받아쓰기와 정답 시각을 나란히 보여 준다.

    python probe_repeats_why.py review.db <곡 id> [--full]     # --full: 줄이지 않은 가사를 넣는다
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import repeat_fill  # noqa: E402
from probe_repeats import collapse  # noqa: E402

db, song_id = Path(sys.argv[1]), int(sys.argv[2])
title, video, raw = sqlite3.connect(db).execute("SELECT title, video_id, lines FROM songs WHERE id=?", (song_id,)).fetchone()
lines = json.loads(raw)
truth = [one["text"] for one in lines]
given_idx = list(range(len(truth))) if "--full" in sys.argv else collapse(truth)
given = [truth[k] for k in given_idx]
words = [(w, at) for w, at in json.load(open(db.parent / "audio" / f"{video}.heard.json", encoding="utf-8"))["낱말"]]
order = repeat_fill.expand(given, words)
print(f"{title} · 넣은 줄 {len(given)} → {len(order)}")
seen: set[int] = set()
for place, k in enumerate(order):
    again = k in seen
    seen.add(k)
    at = lines[given_idx[k]].get("at")
    print(f"  {'+' if again else ' '} {k:>3} {'' if at is None else f'{at / 1000:7.1f}s'}  {given[k][:40]}")
print("\n받아쓰기 (시각 거꾸로 가는 곳은 <)")
last = -1
for word, at in words:
    mark = "<" if at < last - 300 else " "
    last = max(last, at)
    print(f"  {mark} {at / 1000:7.2f} {word}")
