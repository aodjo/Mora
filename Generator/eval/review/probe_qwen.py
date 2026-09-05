#!/usr/bin/env python3
"""**Qwen3-ForcedAligner 를 같은 자로 열 곡에 잰다.** 딴 살림(`~/qwen`)에서 돈다.

이 모델은 짧은 발화용이다. 곡을 통째로 넣으면 무너진다 — 2 번 곡 139 초를 한 번에 넣으니
351 자에 128 단위만 나오고 줄 시작이 바이브보다 9.7 초 앞섰다. 그래서 **줄마다** 바이브 시각
둘레로 창을 잘라 넣는다. 창은 그 줄의 시각 1.5 초 앞부터 다음 줄 시각 1.5 초 뒤까지.

글은 **음절을 띄어** 넣는다. 그러면 낱말이 아니라 음절마다 시각을 준다 — 고스트시티 16 번은
열네 음절이 전부 소리 솟는 자리 40 ms 안에 놓였다(MMS_FA 는 셋만 들었고, kresnik 은 열둘).

재는 자는 `probe_onset` 과 같다: 낱자마다 리드 갈래에서 세기가 솟는 자리까지의 거리, 그리고
`align.flag_stuck` 이 매기는 무너짐. 창을 바이브로 잡으므로 **시계 어긋남은 재지 않는다** —
그 자로는 이 방식이 공짜로 이긴다.

@example
  ~/qwen/bin/python probe_qwen.py 10
"""
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402  (flag_stuck · read_audio · source_in 만 쓴다)
from probe_onset import nearest, onsets_of, words_of  # noqa: E402

#: 줄 창의 여유(ms). 바이브가 조금 틀려도 줄이 창 안에 들게.
MARGIN_MS = 1500
#: 이 안이면 「맞았다」(ms). `probe_onset` 과 같다.
NEAR_MS = 50


def cut(src: Path, since_ms: int, until_ms: int, into: Path) -> None:
    """Write one window of a stem as 16 kHz mono, which is what the aligner takes.

    @param {Path} src - The stem to read.
    @param {int} since_ms - Window start.
    @param {int} until_ms - Window end.
    @param {Path} into - Where to write.
    @returns {None}
    """
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{since_ms / 1000:.3f}",
                    "-t", f"{(until_ms - since_ms) / 1000:.3f}", "-i", str(src),
                    "-ac", "1", "-ar", "16000", str(into)], check=True)


def main() -> int:
    """Align every line of every song with Qwen3 and print the same table `probe_onset` does.

    @returns {int} 0 always.
    """
    import torch
    from qwen_asr import Qwen3ForcedAligner

    where = "mps" if torch.backends.mps.is_available() else "cpu"
    model = Qwen3ForcedAligner.from_pretrained("Qwen/Qwen3-ForcedAligner-0.6B",
                                               dtype=torch.float32, device_map=where)
    conn = sqlite3.connect(HERE / "review.db")
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT id, artist, title, video_id, lines FROM songs ORDER BY id").fetchall()
    how_many = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    print(f"  모델 qwen3 · {where}\n")
    print(f"  {'곡':<30} {'낱자':>5} {'가운뎃값':>7} {'50ms 안':>7} {'무너짐':>5} {'초':>5}")

    every: list[int] = []
    tmp = Path("/tmp/q_line.wav")
    for row in rows[:how_many]:
        found = align.source_in(HERE / "audio", row["video_id"])
        if not found or not found.with_suffix(".lead.wav").exists():
            continue
        lines = json.loads(row["lines"])
        stem = found.with_suffix(".lead.wav")
        began = time.perf_counter()
        out: list[list[dict]] = []
        for index, line in enumerate(lines):
            words = words_of(line.get("text", ""))
            at = line.get("at")
            if not words or at is None:
                out.append([])
                continue
            after = next((one["at"] for one in lines[index + 1:] if one.get("at") is not None), at + 8000)
            since, until = max(0, at - MARGIN_MS), after + MARGIN_MS
            cut(stem, since, until, tmp)
            #: 음절 하나가 한 단위가 되게 띄운다. 낱말 경계는 두 칸으로 남겨 두 걸음으로 되돌린다.
            grains = [[ch for ch in word if not ch.isspace()] for word in words]
            spaced = "  ".join(" ".join(one) for one in grains)
            try:
                got = model.align(audio=str(tmp), text=spaced, language="Korean")[0]
            except Exception:
                out.append([])
                continue
            units = list(got)
            line_out: list[dict] = []
            spot = 0
            for one in grains:
                chars = []
                for ch in one:
                    if spot >= len(units):
                        break
                    unit = units[spot]
                    spot += 1
                    chars.append({"text": ch, "at": int(since + unit.start_time * 1000),
                                  "end": int(since + unit.end_time * 1000), "sure": 0.0})
                if chars:
                    line_out.append({"text": "".join(c["text"] for c in chars), "at": chars[0]["at"],
                                     "end": chars[-1]["end"], "sure": 0.0, "chars": chars})
            out.append(line_out)
        took = time.perf_counter() - began

        align.flag_stuck(lines, out)
        marks = onsets_of(stem)
        far = sorted(nearest(marks, one["at"]) for words in out for word in words
                     for one in (word.get("chars") or []))
        if not far:
            continue
        every.extend(far)
        broke = sum(1 for one in out if one and one[0].get("stuck"))
        within = sum(1 for one in far if one <= NEAR_MS) / len(far)
        print(f"  [{row['id']}] {row['artist'][:9]:<11} — {row['title'][:12]:<14} {len(far):>5} "
              f"{far[len(far) // 2]:>5}ms {within * 100:>6.0f}% {broke:>5} {took:>5.0f}", flush=True)

    if every:
        every.sort()
        print(f"\n  낱자 {len(every)} · 가운뎃값 {every[len(every) // 2]}ms · 50ms 안 "
              f"{sum(1 for one in every if one <= NEAR_MS) / len(every) * 100:.0f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
