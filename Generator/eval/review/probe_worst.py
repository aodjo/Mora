#!/usr/bin/env python3
"""한 곡을 맞추고 **가장 어긋난 줄**을 짚는다. 사람이 어디부터 들을지 정해 준다."""
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
save = "--save" in sys.argv

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
print(f"[{row['id']}] {row['artist']} — {row['title']} · 줄 {len(lines)}")
got = align.align_song(found, lines, words_of)

# 밖에서 온 줄 시각과 견줘 얼마나 어긋났나. 곡 전체의 치우침은 빼고 본다.
pairs = [(i, one[0]["at"] - lines[i]["at"]) for i, one in enumerate(got)
         if one and lines[i].get("at") is not None]
mid = sorted(gap for _, gap in pairs)[len(pairs) // 2]
off = sorted(((abs(gap - mid), i) for i, gap in pairs), reverse=True)

print(f"  치우침 {mid / 1000:+.2f}s · 0.3초 넘게 어긋난 줄 {sum(1 for one, _ in off if one > 300)}개 / {len(off)}")
print("\n  가장 어긋난 여덟 줄")
for gap, index in off[:8]:
    ours = got[index][0]["at"] - mid
    print(f"    {gap:>5.0f}ms  우리 {ours / 1000:6.2f}s · 바이브 {lines[index]['at'] / 1000:6.2f}s"
          f"  {lines[index]['text'][:34]}")

if save:
    next_lines = [{**line, "words": got[i]} if got[i] else line for i, line in enumerate(lines)]
    with sqlite3.connect(HERE / "review.db") as write:
        write.execute("UPDATE songs SET lines=? WHERE id=?",
                      (json.dumps(next_lines, ensure_ascii=False), row["id"]))
    print(f"\n  저장했다 — 화면에서 {row['id']}번 곡을 열면 이 값이 보인다")
