#!/usr/bin/env python3
"""**어느 소리를 바탕으로 맞추는 것이 나은가** — demucs 보컬인가, 카라오케 리드 갈래인가.

한 번 틀렸던 물음이라 다시 잰다. 앞서 「카라오케 모델이 리드를 깎으니 demucs 보컬이 낫다」고
적었는데, 그때 리드라고 부르던 파일이 실은 **백보컬**이었다. 이 모델은 `(Vocals)` 가 백이고
`(Instrumental)` 이 리드인데 이름만 보고 거꾸로 붙였다.

자는 밖에서 온 줄 시각이 아니다 — 음원 판이 다르면 흔들린다. `align.flag_stuck` 이 세는
**정렬 결과 안의 모순**을 쓴다.
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


def count(got) -> int:
    return sum(1 for one in got if one and one[0].get("stuck"))


conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
rows = conn.execute("SELECT id, artist, title, video_id, lines FROM songs ORDER BY id").fetchall()

print(f"  {'곡':<30} {'줄':>4} {'demucs 보컬':>11} {'리드 갈래':>10}")
was = now = 0
for row in rows[: int(sys.argv[1]) if len(sys.argv) > 1 else 8]:
    found = align.source_in(HERE / "audio", row["video_id"])
    if not found:
        continue
    lead = found.with_suffix(".lead.wav")
    if not lead.exists():
        print(f"  {row['title'][:28]:<30} 갈래 없음")
        continue
    lines = json.loads(row["lines"])
    a = count(align.align_song(found, lines, words_of))
    b = count(align.align_song(lead, lines, words_of, separate=False))
    was += a
    now += b
    mark = "←" if b < a else ("!" if b > a else " ")
    print(f"  {(row['artist'][:10] + ' — ' + row['title'][:16]):<30} {len(lines):>4} "
          f"{a:>11} {b:>10} {mark}")
print(f"\n  통틀어 무너짐 — demucs 보컬 {was} · 리드 갈래 {now}")
