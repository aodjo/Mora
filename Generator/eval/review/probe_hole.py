#!/usr/bin/env python3
"""**야해 7 번이 왜 무음 구멍 위에 놓이는가.** 리드 갈래는 44.4~47.58 초가 곡 평균보다 25 dB 아래인
쉼인데(`quiet_holes`), 바탕 정렬은 그 위에 열두 낱자를 확신 −0~−7 로 놓았다. 막았다면 −10000
이어야 한다. `quiet_holes` 가 정렬 중에 불리는지, 무엇을 돌려주는지, 막은 프레임이 어디인지 찍는다.

@example
  MORA_SONG=12 MORA_LINE=7 ./.venv/bin/python probe_hole.py
"""
import glob
import json
import os
import re
import sqlite3
import sys

sys.path.insert(0, ".")
import align  # noqa: E402

NOT = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")
SONG = int(os.environ.get("MORA_SONG", "12"))
LINE = int(os.environ.get("MORA_LINE", "7"))


def words_of(text: str) -> list[str]:
    """Split a line into the words the aligner uses, dropping marks that carry no sound.

    @param {str} text - One lyric line.
    @returns {list[str]} Words worth aligning.
    """
    return [one for one in text.split() if one and not NOT.match(one)]


def main() -> int:
    """Align the lead stem once with the invented clock and report the hole handling.

    @returns {int} 0 always.
    """
    conn = sqlite3.connect(os.environ.get("MORA_DB", "review.db"))
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM songs WHERE id=?", (SONG,)).fetchone()
    lines = json.loads(row["lines"])
    found = align.source_in(align.Path("audio"), row["video_id"])
    if os.environ.get("MORA_CLOCK") == "live":
        #: `align_voices` 가 하는 그대로 — 시계를 파일이 아니라 `heard_clock` 에서 받는다. 그 호출에
        #: 모듈 상태를 바꾸는 곁효과가 있는지 보려는 것이다.
        clock = align.heard_clock(found, lines, words_of)
        print("  heard_clock 살아서 부름")
    else:
        clock = json.load(open(glob.glob(f"audio/{row['video_id']}*.clock.json")[0]))["시계"]
    lines = [{**one, "at": at} for one, at in zip(lines, clock)]
    lead = align.Path(glob.glob(f"audio/{row['video_id']}*.lead.wav")[0])
    print(f"  [{LINE}] 시계 {clock[LINE]}  {lines[LINE]['text']}")

    real_holes = align.quiet_holes

    def traced_holes(stem):
        got = real_holes(stem)
        print(f"  quiet_holes({stem.name}) → {[(a / 1000, b / 1000) for a, b in got]}"
              f"  (부른 곳: {sys._getframe(1).f_code.co_name})")
        return got
    align.quiet_holes = traced_holes

    real_segs = align.lyric_segments

    def traced_segs(*args, **kwargs):
        got = real_segs(*args, **kwargs)
        print(f"  lyric_segments → {len(got)} 토막 {[(round(a, 2), round(b, 2)) for a, b in got][:6]}"
              f"  (부른 곳: {sys._getframe(1).f_code.co_name})")
        return got
    align.lyric_segments = traced_segs

    out = align.align_song(lead, lines, words_of, separate=False, source=found)
    chars = [one for word in out[LINE] for one in (word.get("chars") or []) if one.get("at") is not None]
    print(f"  [{LINE}] " + " ".join(f"{one['at'] / 1000:.2f}/{one.get('sure', 0):.0f}" for one in chars))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
