#!/usr/bin/env python3
"""**한 줄 안에서 목소리가 바뀌는 자리를 잡았는가.**

가사장이 `(If, if I got a, if I got a) would you guarantee?` 를 **한 줄**로 적어 놓는다.
앞의 괄호는 서브가, 뒤는 메인이 부른다. 레인을 줄 단위로만 붙이던 동안 이 줄은 통째로 한
색이었고, 사람이 짚어 준 그대로 「가장 최악인 자리」였다.

여기서 두 손잡이를 견준다 — 도막 자국을 **어느 갈래**에서 뜰 것인가(`VOICE_PART_FROM`),
갈린 줄의 무늬를 같은 글월의 다른 줄에 **옮겨 붙일 것인가**(`VOICE_PART_SPREAD`).

갈래가 문제인 까닭: 리드 갈래는 서브 목소리를 눌러 버리므로 괄호 도막과 그 뒤 꼬리가
같아 보일 위험이 있다. 옮겨 붙이는 것이 문제인 까닭: 도막은 1 초 남짓이라 자국이 흔들려,
글월이 한 글자도 다르지 않은 18·19 번이 서로 거꾸로 나왔다. 어느 쪽도 앉아서 고를 수 없어
재서 고른다.

먼저 같은 글월의 자국을 **더해서** 한 번에 맞히는 것을 해 봤고 더 나빴다 — 더한 자국이 두
도막을 한 무리로 끌어당겨 **갈림 자체가 사라졌다**(2 줄 → 0 줄). 그래서 자국은 그대로 두고
**이미 갈린 줄의 무늬만** 옮긴다.

정답은 Small girl 뿐이다 — 사람이 귀로 짚어 준 곡이 이것 하나다. 18·19·60·61 번은 괄호가
서브(무리 2), 꼬리가 메인(무리 0)이어야 한다. 20·62 번은 통째로 괄호라 도막이 하나뿐이니
안 갈리는 것이 옳다.

곁들여 솔로 곡이 이 때문에 갈리지는 않는지 본다. 도막 자국은 이미 만들어진 무리에 붙기만
하므로 원리상 못 갈라야 한다.
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
SOLO = {1, 2, 4, 5, 6}
MANY = {3, 7, 8, 9}
#: Small girl 에서 한 줄 안에 목소리가 바뀌는 줄. 괄호 쪽이 서브, 꼬리가 메인이다.
TORN = {18, 19, 60, 61}


def words_of(text: str) -> list[str]:
    """Split a line into the words the aligner uses, dropping marks that carry no sound.

    @param {str} text - One lyric line.
    @returns {list[str]} Words worth aligning.
    """
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def torn_lines(out: list[list[dict]]) -> dict[int, list[tuple[str, int | None]]]:
    """Gather the lines whose words did not all land in one lane.

    @param {list[list[dict]]} out - Per-line word dicts carrying lanes.
    @returns {dict[int, list[tuple[str, int | None]]]} Line index to its runs and their lanes.
    """
    found: dict[int, list[tuple[str, int | None]]] = {}
    for index, words in enumerate(out):
        if len({word.get("lane") for word in words if "lane" in word}) < 2:
            continue
        runs: list[tuple[str, int | None]] = []
        mine: list[str] = []
        lane = None
        for word in words:
            one = word.get("lane")
            if mine and one != lane:
                runs.append((" ".join(mine), lane))
                mine = []
            lane = one
            mine.append(word["text"])
        if mine:
            runs.append((" ".join(mine), lane))
        found[index] = runs
    return found


conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
rows = conn.execute("SELECT id, artist, title, video_id, lines FROM songs ORDER BY id").fetchall()
how_many = int(sys.argv[1]) if len(sys.argv) > 1 else 9
ways = [(one, two) for one in ("lead", "back", "vocals") for two in (True, False)]

for row in rows[:how_many]:
    found = align.source_in(HERE / "audio", row["video_id"])
    if not found or not found.with_suffix(".lead.wav").exists():
        continue
    lines = json.loads(row["lines"])
    mark = "여럿" if row["id"] in MANY else ("혼자" if row["id"] in SOLO else "?")
    name = f"[{row['id']}] {row['artist'][:10]} — {row['title'][:18]}"
    print(f"\n  {name}  {mark}")

    for where, pool in ways:
        align.VOICE_PART_FROM, align.VOICE_PART_SPREAD = where, pool
        out, lanes = align.align_voices(found, lines, words_of, row["title"])
        tally: dict[int, int] = {}
        for one in lanes.values():
            tally[one] = tally.get(one, 0) + 1
        torn = torn_lines(out)

        say = ""
        if row["id"] == 7:
            right = sum(1 for index in TORN
                        if index in torn and torn[index][0][1] == 2 and torn[index][-1][1] == 0)
            say = f" · 정답 {right}/{len(TORN)} · 헛짚음 {len(set(torn) - TORN)}"
        print(f"    {where:<6} {'옮김' if pool else '그대로':<5} "
              f"레인 {str(dict(sorted(tally.items()))):<20} 갈린 줄 {len(torn):>2}{say}")
        for index in sorted(torn)[:3]:
            parts = " ".join(f"[{text}]({lane})" for text, lane in torn[index])
            print(f"        {index:>3}번  {parts[:92]}")
