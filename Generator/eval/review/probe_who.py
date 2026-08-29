#!/usr/bin/env python3
"""**목소리가 바뀌는 자리를 잡아내는가.** 문턱을 정하려고 여러 값을 훑는다.

카라오케 모델은 「리드 대 화음」을 가를 뿐 **누가 부르는가**는 못 가른다. 피처링 가수는
저 혼자 리드로 부르므로 리드 갈래에 그대로 들어간다.

여기서는 줄마다 목소리 자국을 떠서 묶고, 문턱을 바꿔 가며 **몇 사람으로 갈리는지**와
**어느 줄에서 갈리는지**를 본다. 답을 아는 곡으로 재야 한다 — 제목에 `Feat.` 이 있으면
적어도 두 사람이다.
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


want = sys.argv[1] if len(sys.argv) > 1 else "Trip"
marks = [float(one) for one in sys.argv[2:]] or [0.25, 0.35, 0.45, 0.55]

conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
row = conn.execute(
    "SELECT id, artist, title, video_id, lines FROM songs WHERE title LIKE ? OR artist LIKE ?",
    (f"%{want}%", f"%{want}%")).fetchone()
if row is None:
    raise SystemExit(f"{want!r} 로 찾히는 곡이 없다")
found = align.source_in(HERE / "audio", row["video_id"])
if not found:
    raise SystemExit("음원이 없다")

lines = json.loads(row["lines"])
lead, _ = align.voices_of(found)
out = align.align_song(lead, lines, words_of, separate=False)
print(f"[{row['id']}] {row['artist']} — {row['title']} · 줄 {len(lines)}\n")

for mark in marks:
    align.VOICE_APART = mark
    who = align.who_sings(lead, out)
    seen = [one for one in who if one is not None]
    tally: dict[int, int] = {}
    for one in seen:
        tally[one] = tally.get(one, 0) + 1
    # 목소리가 바뀌는 자리. 사람이 듣고 맞는지 볼 수 있게 줄 번호를 남긴다.
    turns = [i for i, (a, b) in enumerate(zip(who, who[1:]), start=1)
             if a is not None and b is not None and a != b]
    print(f"  문턱 {mark:.2f} · 사람 {len(tally)}명 {dict(sorted(tally.items()))} · "
          f"바뀌는 자리 {len(turns)}")
    for i in turns[:6]:
        print(f"      {i:>3}번에서 {who[i - 1]} → {who[i]}   {lines[i]['text'][:38]}")
