#!/usr/bin/env python3
"""**목소리 가름이 흩어져 있는가.** 「애매하게 안 된다」를 수치로 바꾼다.

사람이 목소리 구분이 제대로 안 된다고 했다. 무엇이 잘못인지부터 갈라야 한다:

* **흩어짐** — 한두 줄씩 이쪽저쪽으로 튄다. 진짜 화자 교대는 덩어리로 오므로, 홑줄이 많으면
  묶기가 흔들리는 것이다. 이건 **시간으로 다듬어** 고칠 수 있다.
* **통째로 틀림** — 덩어리는 지지만 사람이 아는 것과 다르게 갈린다. 이건 자국 모델을
  바꿔야 하는 문제라 다듬어서는 안 된다.

둘은 고치는 방법이 다르므로 먼저 어느 쪽인지 본다.
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


def runs(seq: list[int]) -> list[tuple[int, int, int]]:
    """이어진 덩어리들. (시작 줄, 길이, 레인)."""
    out: list[tuple[int, int, int]] = []
    for index, one in enumerate(seq):
        if out and out[-1][2] == one and out[-1][0] + out[-1][1] == index:
            out[-1] = (out[-1][0], out[-1][1] + 1, one)
        else:
            out.append((index, 1, one))
    return out


conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
how_many = int(sys.argv[1]) if len(sys.argv) > 1 else 9

print(f"  {'곡':<30} {'줄':>4} {'갈래':>4} {'덩어리':>6} {'홑줄':>5} {'가장 긴':>7}  나눔")
for row in conn.execute("SELECT id,artist,title,video_id,lines FROM songs ORDER BY id").fetchall()[:how_many]:
    found = align.source_in(HERE / "audio", row["video_id"])
    if not found or not found.with_suffix(".lead.wav").exists():
        continue
    lines = json.loads(row["lines"])
    _, lanes = align.align_voices(found, lines, words_of, row["title"])
    seq = [lanes.get(index, 0) for index in range(len(lines))]

    blocks = runs(seq)
    alone = sum(1 for _, size, _ in blocks if size == 1)
    longest = max((size for _, size, _ in blocks), default=0)
    tally: dict[int, int] = {}
    for one in seq:
        tally[one] = tally.get(one, 0) + 1
    name = f"[{row['id']}] {row['artist'][:9]} — {row['title'][:14]}"
    print(f"  {name:<30} {len(lines):>4} {len(tally):>4} {len(blocks):>6} {alone:>5} "
          f"{longest:>7}  {dict(sorted(tally.items()))}", flush=True)
