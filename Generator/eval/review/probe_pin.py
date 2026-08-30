#!/usr/bin/env python3
"""**되짚기가 실제로 먹히는가.** 못을 몇 개 박았고, 박은 대로 다시 맞췄는가.

`rethink` 이 무너진 줄을 찾아 못을 내놓아도 `pinned` 은 도막 하나만 실패하면 **통째로 물러선다.**
물러서면 화면에는 아무 자국이 안 남으므로, 무너짐 수만 봐서는 「못을 안 박았다」와 「박았는데
물러섰다」를 못 가른다. 여기서 그 둘을 갈라 본다.
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


seen: dict[str, object] = {}
was_rethink, was_pinned = align.rethink, align.pinned


def watch_rethink(log_probs, tokens, heads, spans, lines, merged, per_frame):
    """Stand in for `rethink` to note how many pins it produced.

    @param {torch.Tensor} log_probs - Frame log probabilities.
    @param {list[int]} tokens - Every token of the song.
    @param {list[int | None]} heads - First token index of each line.
    @param {list[int]} spans - Token count of each line.
    @param {list[dict]} lines - Lyric lines.
    @param {list} merged - Per-token spans from the first pass.
    @param {float} per_frame - Milliseconds a frame covers.
    @returns {list[tuple[int, int]]} Whatever the real function answers.
    """
    got = was_rethink(log_probs, tokens, heads, spans, lines, merged, per_frame)
    seen["pins"] = got
    seen["per_frame"] = per_frame
    seen["heads"] = heads
    return got


def watch_pinned(log_probs, tokens, pins):
    """Stand in for `pinned` to note whether it backed out.

    @param {torch.Tensor} log_probs - Frame log probabilities.
    @param {list[int]} tokens - Every token of the song.
    @param {list[tuple[int, int]]} pins - Pins from `rethink`.
    @returns {list | None} Whatever the real function answers.
    """
    got = was_pinned(log_probs, tokens, pins)
    seen["backed"] = got is None
    return got


align.rethink, align.pinned = watch_rethink, watch_pinned

conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
want = [int(one) for one in sys.argv[1:]] or [7]
for song in want:
    row = conn.execute("SELECT * FROM songs WHERE id=?", (song,)).fetchone()
    found = align.source_in(HERE / "audio", row["video_id"])
    if not found:
        continue
    lines = json.loads(row["lines"])
    seen.clear()
    align.align_song(found, lines, words_of)

    pins = seen.get("pins") or []
    per_frame = seen.get("per_frame") or 1
    heads = seen.get("heads") or []
    where = {head: index for index, head in enumerate(heads) if head is not None}
    print(f"\n  [{song}] {row['artist'][:12]} — {row['title'][:24]}")
    print(f"    못 {len(pins)}개 · 되맞춤 {'물러섬' if seen.get('backed') else '먹힘'}")
    for head, frame in pins:
        index = where.get(head, "?")
        said = lines[index]["at"] / 1000 if isinstance(index, int) else 0
        print(f"      {str(index):>4}번 → {frame * per_frame / 1000:7.2f}s  (바이브 {said:7.2f}s)"
              f"  {lines[index]['text'][:30] if isinstance(index, int) else ''}")
