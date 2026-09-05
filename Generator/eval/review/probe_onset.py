#!/usr/bin/env python3
"""**낱자 시각이 실제 소리와 얼마나 가까운가.** 소리 세기가 솟는 자리와 낱자마다 대질한다.

무너진 줄 수와 시계 어긋남은 **줄** 단위 자다. 낱자가 제 칸 안 어디에 놓이는지는 못 본다 —
고스트시티 16 번은 시작이 시계에 맞고 줄도 안 넘지만, 열네 음절이 0.25 초 간격으로 고르게
펴져 있어 귀에는 어긋난다. 그것을 잡는 자가 이것이다.

리드 갈래에서 세기가 가파르게 솟는 자리를 찾고, 낱자마다 가장 가까운 솟음까지의 거리를 잰다.
곡마다 그 거리의 가운뎃값과 50 ms 안에 든 낱자의 비율을 찍는다. 자음 시작과 세기 봉우리는
100 ms 쯤 어긋날 수 있어 절대값보다 **두 모델을 같은 자로 견주는 데** 쓴다.

`MORA_ACOUSTIC=mms` 와 `kresnik` 으로 두 번 돌려 나란히 본다.

@example
  MORA_ACOUSTIC=kresnik python probe_onset.py 10
"""
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402

NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")
#: 세기를 재는 걸음(ms).
HOP_MS = 10
#: 이 안이면 「맞았다」로 친다(ms).
NEAR_MS = 50


def words_of(text: str) -> list[str]:
    """Split a line into the words the aligner uses, dropping marks that carry no sound.

    @param {str} text - One lyric line.
    @returns {list[str]} Words worth aligning.
    """
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def onsets_of(stem: Path) -> list[int]:
    """Find where loudness climbs sharply in a stem, in ms.

    A climb is the loudness now minus one hop ago, floored at zero; a peak is the sharpest
    climb within ±60 ms that is also loud enough to be a voice rather than noise.

    @param {Path} stem - The audio to read.
    @returns {list[int]} Onset times in ms, ascending.
    """
    import torch
    wave = align.read_audio(stem, 16_000, 1)[0]
    hop = 16_000 * HOP_MS // 1000
    win = hop * 3
    pad = torch.nn.functional.pad(wave.unsqueeze(0).unsqueeze(0), (win, win))
    loud = torch.nn.functional.avg_pool1d(pad.abs(), kernel_size=win * 2, stride=hop)[0, 0]
    climb = torch.clamp(loud[1:] - loud[:-1], min=0)
    out: list[int] = []
    for at in range(6, len(climb) - 6):
        if climb[at] == climb[at - 6:at + 7].max() and climb[at] > 0.004 and loud[at + 1] > 0.02:
            out.append(at * HOP_MS)
    return out


def nearest(marks: list[int], at: int) -> int:
    """Distance from a time to the nearest onset, in ms.

    @param {list[int]} marks - Onset times, ascending.
    @param {int} at - The time to place.
    @returns {int} Absolute distance to the closest onset, or a large number when there are none.
    """
    import bisect
    if not marks:
        return 10_000
    spot = bisect.bisect_left(marks, at)
    near = [marks[one] for one in (spot - 1, spot) if 0 <= one < len(marks)]
    return min(abs(one - at) for one in near)


conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
rows = conn.execute("SELECT id, artist, title, video_id, lines FROM songs ORDER BY id").fetchall()
how_many = int(sys.argv[1]) if len(sys.argv) > 1 else 10
print(f"  모델 {os.environ.get('MORA_ACOUSTIC', 'mms')}\n")
print(f"  {'곡':<30} {'낱자':>5} {'가운뎃값':>7} {'50ms 안':>7} {'들림':>6} {'무너짐':>5}")

every: list[int] = []
heard_all = total_all = 0
for row in rows[:how_many]:
    found = align.source_in(HERE / "audio", row["video_id"])
    if not found or not found.with_suffix(".lead.wav").exists():
        continue
    lines = json.loads(row["lines"])
    out, _ = align.align_voices(found, lines, words_of, row["title"])
    marks = onsets_of(found.with_suffix(".lead.wav"))
    far: list[int] = []
    heard = 0
    for words in out:
        for word in words:
            for one in word.get("chars") or []:
                if one.get("at") is None:
                    continue
                far.append(nearest(marks, one["at"]))
                heard += one.get("sure", -9.0) >= align.SURE_HEARD
    if not far:
        continue
    far.sort()
    every.extend(far)
    heard_all += heard
    total_all += len(far)
    broke = sum(1 for one in out if one and one[0].get("stuck"))
    within = sum(1 for one in far if one <= NEAR_MS) / len(far)
    print(f"  [{row['id']}] {row['artist'][:9]:<11} — {row['title'][:12]:<14} {len(far):>5} "
          f"{far[len(far) // 2]:>5}ms {within * 100:>6.0f}% {heard / len(far) * 100:>5.0f}% {broke:>5}")

if every:
    every.sort()
    print(f"\n  낱자 {len(every)} · 가운뎃값 {every[len(every) // 2]}ms · 50ms 안 "
          f"{sum(1 for one in every if one <= NEAR_MS) / len(every) * 100:.0f}% · 들린 낱자 "
          f"{heard_all / total_all * 100:.0f}%")
