#!/usr/bin/env python3
"""**되풀이되는 구절이 늘 같은 사람에게 가는가.** 솔로의 헛갈림과 진짜 화자 갈림을 가른다.

덩어리 문턱만으로는 맞바꿈이 생긴다 — 6 으로 두면 빅뱅이 5 줄만 갈리고, 3 으로 낮추면
그룹은 제대로 갈리지만 솔로 곡 둘이 헛갈린다(같은 사람의 창법 변화를 다른 사람으로 본다).

여기서 시험하는 자는 **되풀이의 한결같음**이다. 같은 구절을 곡에서 여러 번 부르면 대개
같은 사람이 부른다 — 붉은 노을의 `난 너를 사랑해 (uh-huh, I love you, girl)` 는 13·25·41 번
모두 같은 레인으로 갔다. 반면 창법 변화로 갈린 묶음은 같은 구절이 이번엔 이쪽, 다음엔
저쪽으로 흩어질 것이다.

재는 것: 두 번 이상 나오는 글월 가운데 **모든 번이 한 묶음에 든 것의 비율.**
"""
import json
import re
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402

NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")
SOLO = {1, 2, 4, 5, 6}
MANY = {3, 7, 8, 9}


def words_of(text: str) -> list[str]:
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
rows = conn.execute("SELECT id, artist, title, video_id, lines FROM songs ORDER BY id").fetchall()
how_many = int(sys.argv[1]) if len(sys.argv) > 1 else 9
if len(sys.argv) > 2:
    align.VOICE_RUN = align.VOICE_RUN_TOLD = int(sys.argv[2])

print(f"  덩어리 문턱 {align.VOICE_RUN}\n")
print(f"  {'곡':<32} {'여럿?':>5} {'레인':>18} {'되풀이 글월':>10} {'한결같음':>9}")
for row in rows[:how_many]:
    found = align.source_in(HERE / "audio", row["video_id"])
    if not found or not found.with_suffix(".lead.wav").exists():
        continue
    lines = json.loads(row["lines"])
    _, lanes = align.align_voices(found, lines, words_of, row["title"])

    tally: dict[int, int] = {}
    for one in lanes.values():
        tally[one] = tally.get(one, 0) + 1

    #: 두 번 이상 나오는 글월마다, 모든 번이 한 레인에 들었나.
    same: dict[str, list[int]] = defaultdict(list)
    for index, line in enumerate(lines):
        text = " ".join(line.get("text", "").split())
        if text and index in lanes:
            same[text].append(lanes[index])
    twice = [one for one in same.values() if len(one) > 1]
    steady = sum(1 for one in twice if len(set(one)) == 1)
    share = f"{steady}/{len(twice)}" if twice else "—"
    ratio = steady / len(twice) if twice else 1.0

    name = f"[{row['id']}] {row['artist'][:9]} — {row['title'][:14]}"
    mark = "여럿" if row["id"] in MANY else ("혼자" if row["id"] in SOLO else "?")
    print(f"  {name:<32} {mark:>5} {str(dict(sorted(tally.items()))):>18} "
          f"{len(twice):>10} {share:>6} {ratio * 100:>5.0f}%")
