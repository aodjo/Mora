#!/usr/bin/env python3
"""**어느 줄을 못 맞췄고 왜인가.**

사람이 손으로 고치는 길을 없앴으므로 못 맞춘 줄은 영영 빈 채로 남는다. 그러니 「몇 줄
못 맞췄다」로 끝낼 수 없고 **왜**인지 갈라야 한다:

* 부를 것이 없는 줄(`♪`, 빈 줄) — 맞출 것이 없으니 못 맞춘 것이 아니다.
* 글월은 있는데 토큰이 안 나온 줄 — 로마자로 옮길 수 없는 글자만 있는 경우다.
* 토큰은 있는데 자리를 못 얻은 줄 — 이것이 진짜 실패다.
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


conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
how_many = int(sys.argv[1]) if len(sys.argv) > 1 else 9

kinds = {"부를 것 없음": 0, "토큰 안 나옴": 0, "자리 못 얻음": 0}
print(f"  {'곡':<28} {'줄':>4} {'못 맞춤':>7}  까닭별")
for row in conn.execute("SELECT id,artist,title,lines FROM songs ORDER BY id").fetchall()[:how_many]:
    lines = json.loads(row["lines"])
    here = {"부를 것 없음": [], "토큰 안 나옴": [], "자리 못 얻음": []}
    for index, line in enumerate(lines):
        words = line.get("words") or []
        if any(one.get("at") is not None for one in words):
            continue
        said = words_of(line.get("text", ""))
        if not said:
            here["부를 것 없음"].append(index)
            continue
        tokens = []
        for word in said:
            for grain in align.grains_of(align.speakable(word)):
                tokens.extend(align.letters(grain))
        here["토큰 안 나옴" if not tokens else "자리 못 얻음"].append(index)

    missed = sum(len(one) for one in here.values())
    for name, got in here.items():
        kinds[name] += len(got)
    name = f"[{row['id']}] {row['artist'][:8]} — {row['title'][:13]}"
    tail = " · ".join(f"{k} {len(v)}" for k, v in here.items() if v)
    print(f"  {name:<28} {len(lines):>4} {missed:>7}  {tail}")
    for one in here["자리 못 얻음"][:3]:
        print(f"        자리 못 얻음 {one}번: {lines[one]['text'][:44]!r}")
    for one in here["토큰 안 나옴"][:3]:
        print(f"        토큰 안 나옴 {one}번: {lines[one]['text'][:44]!r}")

print(f"\n  통틀어 — " + " · ".join(f"{k} {v}" for k, v in kinds.items()))
