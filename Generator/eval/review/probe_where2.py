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
kinds = [one for one in sys.argv[3:] if not one.replace(".", "").isdigit()] or ["lead"]
spots = [float(one) for one in sys.argv[3:] if one.replace(".", "").isdigit()] or [0.0]

conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
row = conn.execute("SELECT * FROM songs WHERE id=?", (song,)).fetchone()
found = align.source_in(HERE / "audio", row["video_id"])
lines = json.loads(row["lines"])
align.voices_of(found)
where = {"lead": found.with_suffix(".lead.wav"), "back": found.with_suffix(".back.wav"),
         "vocals": align.vocals_of(found), "원본": found}

mask = align.inside_parens(lines[which].get("text", ""), words_of)
groups = {"통째로": None, "괄호 밖": False, "괄호 안": True}
print(f"  [{song}] {row['title'][:30]} · {which}번  {lines[which]['text'][:44]}")
print(f"  바이브 {lines[which]['at'] / 1000:.2f}s\n")

for kind in kinds:
    audio = align.read_audio(where[kind], align.SAMPLE_RATE, 1)[0].unsqueeze(0)
    log_probs = align.whole_logits(audio)
    per_frame = audio.shape[-1] / log_probs.shape[1] / align.SAMPLE_RATE * 1000
    for name, want in groups.items():
        tokens = []
        for at, word in enumerate(words_of(lines[which].get("text", ""))):
            if want is not None and (at < len(mask) and mask[at]) != want:
                continue
            for grain in align.grains_of(align.speakable(word)):
                tokens.extend(align.letters(grain))
        if not tokens:
            continue
        width = max(len(tokens) * 120, 2500) + 2 * align.LOOK_MS
        say = []
        for spot in spots:
            since = max(0, int((spot * 1000 - align.LOOK_MS) / per_frame))
            until = min(log_probs.shape[1], int((spot * 1000 - align.LOOK_MS + width) / per_frame))
            got = align.weigh(log_probs, tokens, since, until)
            say.append("못 잼" if got is None
                       else f"{got[0]:+7.3f} @{got[1] * per_frame / 1000:7.2f}s")
        print(f"    {kind:<6} {name:<6} 낱자 {len(tokens):>3}  " + "  ".join(say))
