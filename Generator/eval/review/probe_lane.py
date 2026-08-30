#!/usr/bin/env python3
"""**줄마다 누가 부르는가** — 갈래진 결과를 정답과 견준다.

정답(사용자가 짚어 줌): Small girl 의 `(If, if I got a …)` 는 다른 사람이 부른다 —
18·19·20·60·61·62 번. 솔로 곡은 갈리면 안 된다.
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
TRUTH = {7: {18, 19, 20, 60, 61, 62}}
#: 혼자 부르는 곡. 화자로 갈리면 안 된다. 레인 1 이 있어도 그것은 백보컬 구제일 수 있으니
#: 몇 줄인지로 가늠한다 — 화자 갈림은 이어진 덩어리라 대개 여러 줄이다.
SOLO = {1, 2, 4, 5, 6}
GROUP = {9}


def words_of(text: str) -> list[str]:
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
rows = conn.execute("SELECT id, artist, title, video_id, lines FROM songs ORDER BY id").fetchall()
how_many = int(sys.argv[1]) if len(sys.argv) > 1 else 9
#: 문턱을 밖에서 준다. 곡을 더 넣을 때마다 다시 정해야 하는 값이라 코드를 고치지 않고 잰다.
if len(sys.argv) > 2:
    align.VOICE_RUN = int(sys.argv[2])
    align.VOICE_RUN_TOLD = int(sys.argv[2])
print(f"  덩어리 문턱 {align.VOICE_RUN} (제목이 알려 주면 {align.VOICE_RUN_TOLD})\n")

for row in rows[:how_many]:
    found = align.source_in(HERE / "audio", row["video_id"])
    if not found or not found.with_suffix(".lead.wav").exists():
        continue
    lines = json.loads(row["lines"])
    out, lanes = align.align_voices(found, lines, words_of, row["title"])

    tally: dict[int, int] = {}
    for one in lanes.values():
        tally[one] = tally.get(one, 0) + 1
    name = f"[{row['id']}] {row['artist'][:10]} — {row['title'][:18]}"
    mark = ""
    if row["id"] in TRUTH:
        hit = sum(1 for index in TRUTH[row["id"]] if lanes.get(index))
        mark = f"  ◀ 정답 {hit}/{len(TRUTH[row['id']])}"
    elif row["id"] in GROUP:
        mark = "  ◀ 그룹 (여럿이 번갈아 부른다)"
    elif row["id"] in SOLO:
        mark = "  ◀ 솔로 (안 갈려야 맞다)"
    print(f"  {name:<34} 레인 {dict(sorted(tally.items()))}{mark}", flush=True)

    if row["id"] in TRUTH:
        last = None
        for index in range(len(lines)):
            one = lanes.get(index, 0)
            if one != last:
                print(f"        {index:>3}번부터 레인 {one}   {lines[index]['text'][:40]}")
                last = one
