#!/usr/bin/env python3
"""**한 줄이 여기서 불렸나 저기서 불렸나.** 두 자리에 같은 글월을 놓고 점수를 견준다.

되짚기가 밖에서 온 시각에 못을 박아도, 그 안에서 다시 맞추면 모델이 다른 자리를 고를 수
있다. 그것이 모델이 옳아서인지 밖의 시각이 옳아서인지는 **점수로만** 가른다 —
`align.weigh` 가 창 안에서 그 글월을 가장 잘 놓았을 때의 낱자당 점수를 돌려준다.

@example
  python probe_where2.py 7 20 60.03 65.25
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


song = int(sys.argv[1])
which = int(sys.argv[2])
spots = [float(one) for one in sys.argv[3:]] or [0.0]

conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
row = conn.execute("SELECT * FROM songs WHERE id=?", (song,)).fetchone()
found = align.source_in(HERE / "audio", row["video_id"])
lines = json.loads(row["lines"])
lead, _ = align.voices_of(found)

audio = align.read_audio(lead, align.SAMPLE_RATE, 1)[0].unsqueeze(0)
log_probs = align.whole_logits(audio)
per_frame = audio.shape[-1] / log_probs.shape[1] / align.SAMPLE_RATE * 1000

tokens = []
for word in words_of(lines[which].get("text", "")):
    for grain in align.grains_of(align.speakable(word)):
        tokens.extend(align.letters(grain))

print(f"  [{song}] {row['title'][:30]} · {which}번  {lines[which]['text'][:40]}")
print(f"  낱자 {len(tokens)}개 · 바이브 {lines[which]['at'] / 1000:.2f}s\n")
width = max(len(tokens) * 120, 2500) + 2 * align.LOOK_MS
for spot in spots:
    since = max(0, int((spot * 1000 - align.LOOK_MS) / per_frame))
    until = min(log_probs.shape[1], int((spot * 1000 - align.LOOK_MS + width) / per_frame))
    got = align.weigh(log_probs, tokens, since, until)
    if got is None:
        print(f"    {spot:7.2f}s  못 잼")
        continue
    print(f"    {spot:7.2f}s 언저리  낱자당 {got[0]:+.4f}  가장 좋은 자리 {got[1] * per_frame / 1000:7.2f}s")
