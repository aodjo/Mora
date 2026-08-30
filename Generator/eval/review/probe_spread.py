#!/usr/bin/env python3
"""**몰린 낱자가 실제로 펴졌는가.** 곡을 맞춘 뒤 줄마다 낱자 사이를 찍는다.

`spread_crammed` 는 따로 부르면 도는데 화면에는 여전히 80 밀리초가 나온다. 함수가 안 도는지,
도는데 뒤에서 누가 되돌리는지, 아니면 그 줄이 다른 갈래에서 온 것인지를 가른다 — 셋 다
「안 고쳐졌다」로만 보여서 수만 봐서는 못 가린다.

@example
  python probe_spread.py 9 13 14 15
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
    """Split a line into the words the aligner uses, dropping marks that carry no sound.

    @param {str} text - One lyric line.
    @returns {list[str]} Words worth aligning.
    """
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def gaps_of(words: list[dict]) -> tuple[list[dict], list[int]]:
    """Flatten a line's characters and report the spacing between them.

    @param {list[dict]} words - One line's word dicts.
    @returns {tuple[list[dict], list[int]]} The characters and the gaps between their starts.
    """
    chars = [one for word in words for one in (word.get("chars") or [])]
    return chars, [chars[at + 1]["at"] - chars[at]["at"] for at in range(len(chars) - 1)]


song = int(sys.argv[1]) if len(sys.argv) > 1 else 9
want = [int(one) for one in sys.argv[2:]]
whole = "--voices" in sys.argv

conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
row = conn.execute("SELECT * FROM songs WHERE id=?", (song,)).fetchone()
found = align.source_in(HERE / "audio", row["video_id"])
lines = json.loads(row["lines"])

if whole:
    out, _ = align.align_voices(found, lines, words_of, row["title"])
    print("  align_voices 로 맞춤 (갈래 넷)")
else:
    out = align.align_song(found, lines, words_of)
    print("  align_song 으로 맞춤 (원본 하나)")

floor = 0
for index, words in enumerate(out):
    chars, gaps = gaps_of(words)
    if not gaps:
        continue
    if all(one <= align.CRAMP_MS for one in gaps):
        floor += 1
    if index in want:
        print(f"  {index:>3}번 {chars[0]['at'] / 1000:7.2f}~{chars[-1]['end'] / 1000:7.2f} "
              f"낱자 {len(chars):>2}  사이 {gaps[:6]}")
print(f"  낱자가 모두 최소 간격인 줄 {floor}개")

#: 한 번 더 부른다. 여기서 값이 바뀌면 `align_song` 안에서는 안 불렸다는 뜻이고, 안 바뀌면
#: 불렸는데 덩어리를 못 알아본 것이다. 둘 다 「안 고쳐졌다」로만 보이므로 이렇게 가른다.
flat = [one for words in out for word in words
        for one in (word.get("chars") or []) if one["at"] is not None]
print(f"\n  곡 전체 낱자 {flat and len(flat)}개 · 못 놓은 낱자 "
      f"{sum(1 for words in out for word in words for one in (word.get('chars') or []) if one['at'] is None)}개")
spot = 0
while spot < len(flat):
    last = spot
    while last + 1 < len(flat) and flat[last + 1]["at"] - flat[last]["at"] <= align.PACKED_MS:
        last += 1
    count = last - spot + 1
    if count >= align.CRAMP_RUN:
        roof = (flat[last + 1]["at"] if last + 1 < len(flat)
                else (flat[last]["end"] or flat[last]["at"]))
        base = flat[spot]["at"]
        room = min(roof - base, count * align.SPREAD_MOST_MS)
        need = max(count * align.CRAMP_MS, flat[last]["at"] - base) * align.CRAMP_ROOM
        print(f"    덩어리 {base / 1000:7.2f}s 낱자 {count:>2}  방 {room:>5}ms  필요 {need:>6.0f}ms  "
              f"{'편다' if room > need else '안 폄'}")
    spot = last + 1

align.unpack_song(out)
print("\n  밖에서 한 번 더 편 뒤")
for index, words in enumerate(out):
    chars, gaps = gaps_of(words)
    if gaps and index in want:
        print(f"  {index:>3}번 {chars[0]['at'] / 1000:7.2f}~{chars[-1]['end'] / 1000:7.2f} "
              f"낱자 {len(chars):>2}  사이 {gaps[:6]}")
