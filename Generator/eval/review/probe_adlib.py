#!/usr/bin/env python3
"""**애드리브·백보컬 줄이 정렬을 무너뜨리는가.** 무너뜨린다면 어떤 방식으로인가.

강제 정렬은 **차례를 지킨다**(monotonic). 가사의 글자를 적힌 순서대로만 소리에 붙일 수 있다.
그런데 백보컬은 리드와 **동시에** 불린다 — 가사 파일에는 앞뒤로 적혀 있지만 소리에서는
겹친다. 겹치는 것을 차례로만 놓을 수 있는 정렬기에 넣으면, 그 줄이 앞 줄의 소리를 빼앗거나
엉뚱한 데로 밀려난다.

여기서 재는 것 셋:

1. **밖에서 온 줄 시각이 이미 겹치는가.** 겹친다면 그건 우리 정렬의 실수가 아니라
   **모형이 표현할 수 없는 것**을 넣고 있는 것이다. 고치는 방향이 완전히 달라진다.
2. 괄호 친 줄이 실제로 더 많이 어긋나는가.
3. 그 줄들을 **아예 빼고** 맞추면 나머지가 나아지는가 — 애드리브가 옆줄까지
   망가뜨리고 있는지 보는 가장 곧은 자.
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
# 괄호로 감싸인 줄. 가사 파일에서 백보컬·애드리브를 적는 가장 흔한 꼴이다.
WRAPPED = re.compile(r"^\s*[(\[][^)\]]*[)\]]\s*$")


def words_of(text: str) -> list[str]:
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def middle(values):
    got = sorted(values)
    return got[len(got) // 2] if got else 0


conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
rows = conn.execute("SELECT id, artist, title, video_id, lines FROM songs ORDER BY id").fetchall()
how_many = int(sys.argv[1]) if len(sys.argv) > 1 else 8
drop = "--drop" in sys.argv   # 괄호 줄을 아예 빼고 맞춰 본다

print("괄호 줄을 빼고 맞춘다\n" if drop else "있는 그대로 맞춘다\n")
tally = {"괄호": [], "보통": []}
for row in rows[:how_many]:
    found = align.source_in(HERE / "audio", row["video_id"])
    if not found:
        continue
    lines = json.loads(row["lines"])

    # 1. 밖에서 온 줄 시각끼리 이미 겹치는가. 다음 줄이 앞 줄보다 **먼저** 시작하거나
    #    같은 때 시작하면, 그 둘은 소리에서 겹쳐 있다는 뜻이다.
    same = sum(1 for a, b in zip(lines, lines[1:])
               if a.get("at") is not None and b.get("at") is not None and b["at"] <= a["at"])
    wrapped = [i for i, one in enumerate(lines) if WRAPPED.match(one.get("text", ""))]

    fed = [dict(one) for one in lines]
    if drop:
        # 글월을 비우면 맞출 토큰이 없어져 그 줄은 건너뛰어진다. 줄 수는 그대로 두어
        # 아래 견줌에서 번호가 어긋나지 않게 한다.
        for i in wrapped:
            fed[i] = {**fed[i], "text": ""}
    got = align.align_song(found, fed, words_of)

    pairs = [(i, one) for i, one in enumerate(got) if one and lines[i].get("at") is not None]
    if not pairs:
        print(f"  [{row['id']}] {row['title'][:24]} — 한 줄도 못 맞춤")
        continue
    bias = middle([one[0]["at"] - lines[i]["at"] for i, one in pairs])

    here = {"괄호": [], "보통": []}
    for i, one in pairs:
        off = abs(one[0]["at"] - lines[i]["at"] - bias)
        here["괄호" if i in wrapped else "보통"].append(off)
        tally["괄호" if i in wrapped else "보통"].append(off)

    name = f"[{row['id']}] {row['artist'][:10]} — {row['title'][:20]}"
    print(f"  {name:<38} 줄 {len(lines):>3} · 괄호 줄 {len(wrapped):>2} · "
          f"밖에서 온 시각이 겹치는 자리 {same:>2}")
    for kind in ("괄호", "보통"):
        if not here[kind]:
            continue
        got_off = sorted(here[kind])
        print(f"      {kind:<3} {len(got_off):>3}줄 · 오차 가운데 {got_off[len(got_off) // 2]:>5.0f}ms · "
              f"p90 {got_off[int(len(got_off) * 0.9)]:>6.0f}ms · 0.3초 초과 {sum(1 for x in got_off if x > 300):>2}줄 · "
              f"3초 초과 {sum(1 for x in got_off if x > 3000):>2}줄")

print()
for kind in ("괄호", "보통"):
    if not tally[kind]:
        continue
    got_off = sorted(tally[kind])
    print(f"  통틀어 {kind:<3} {len(got_off):>3}줄 · 오차 가운데 {got_off[len(got_off) // 2]:>5.0f}ms · "
          f"p90 {got_off[int(len(got_off) * 0.9)]:>6.0f}ms · "
          f"0.3초 초과 {sum(1 for x in got_off if x > 300)} ({sum(1 for x in got_off if x > 300) * 100 // len(got_off)}%) · "
          f"3초 초과 {sum(1 for x in got_off if x > 3000)}")
