#!/usr/bin/env python3
"""한 곡을 **지금 자리에서 새로 맞춰** 줄마다 어디에 놓였는지 그대로 찍는다.

저장된 값과 헷갈리지 않으려고 따로 둔다 — 데이터베이스의 `words` 는 옛 모델이 남긴 것이라
지금 코드가 무엇을 하는지 말해 주지 않는다.

    probe_where.py 사랑하게        # 곡 전체
    probe_where.py 사랑하게 120 145  # 그 초 구간만
"""
import json
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402

NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")


def words_of(text: str) -> list[str]:
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


want = sys.argv[1] if len(sys.argv) > 1 else "사랑하게"
since = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
until = float(sys.argv[3]) if len(sys.argv) > 3 else 1e9

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
got = align.align_song(found, lines, words_of)

pairs = [(i, one) for i, one in enumerate(got) if one and lines[i].get("at") is not None]
bias = sorted(one[0]["at"] - lines[i]["at"] for i, one in pairs)[len(pairs) // 2]
said = Counter(re.sub(r"\s+", " ", line.get("text", "")).strip() for line in lines)

print(f"[{row['id']}] {row['artist']} — {row['title']} · 줄 {len(lines)} · 치우침 {bias / 1000:+.2f}s")
print(f"  {'줄':>3} {'바이브':>8} {'우리':>8} {'어긋남':>8}  {'되풀이':<4} 글자  글월")
for index, line in enumerate(lines):
    if not (since <= line.get("at", 0) / 1000 <= until):
        continue
    one = got[index]
    text = re.sub(r"\s+", " ", line.get("text", "")).strip()
    mark = f"{said[text]}번" if said[text] > 1 else "  "
    if not one:
        print(f"  {index:>3} {line['at'] / 1000:>7.2f}s {'못 맞춤':>9} {'':>8}  {mark:<4}")
        continue
    chars = [c for w in one for c in (w.get("chars") or [])]
    off = one[0]["at"] - line["at"] - bias
    #: 그 줄이 얼마나 벌어져 있나. 되풀이가 어긋날 때는 시작만이 아니라 줄 전체가 눌린다.
    span = (chars[-1]["end"] - chars[0]["at"]) / 1000 if chars else 0
    print(f"  {index:>3} {line['at'] / 1000:>7.2f}s {one[0]['at'] / 1000:>7.2f}s "
          f"{off:>+7.0f}ms  {mark:<4} {len(chars):>2}자 {span:>5.2f}s  {text[:30]}")
