#!/usr/bin/env python3
"""
숨 자리 문턱(BREATH_FLOOR)을 다시 잰다.

Server/src/admin/quality-gate.ts 의 문턱은 열두 곡으로 놓았다. 적은 수이고 두 가수에 몰려
있어, 목록이 다시 차면 다시 재야 한다고 그 주석에 적어 두었다 — 잴 때 쓰는 것이 이 파일이다.

    python3 Generator/eval/breath.py <보컬스템.wav> <후보.json>

후보 json 은 {"lines": "[[시작ms, 끝ms], ...]", "text": "가사"} 꼴이다. D1 에서 이렇게 뽑는다:

    SELECT CAST(c.line_spans AS TEXT) lines, l.text text
    FROM alignment_candidates c JOIN lyric_texts l ON l.id = c.variant_id
    WHERE c.id = ?

데몬이 쓰는 breath_gaps() 와 같은 셈이다. 다른 셈을 하면 재는 의미가 없으므로, 데몬 쪽을
고치면 여기도 함께 고친다 — 이 파일은 한 곡을 자세히 들여다보기 위한 것이고, 판정 자체는
mora_ml_daemon.breath_gaps 가 한다.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy
import soundfile

FRAME = 0.02
# 이만큼 내려앉으면 숨 쉬는 자리로 본다. 사람 목소리의 한 소절 끝은 대개 10dB 넘게 떨어진다.
BREATH_DROP = 8.0


def loudness(path: Path) -> numpy.ndarray:
    data, rate = soundfile.read(str(path), always_2d=True)
    mono = data.mean(axis=1)
    step = max(1, int(rate * FRAME))
    block = mono[: len(mono) // step * step].reshape(-1, step)
    power = numpy.sqrt((block.astype(numpy.float64) ** 2).mean(axis=1))
    return 20 * numpy.log10(numpy.maximum(power, 1e-10))


def main() -> None:
    loud = loudness(Path(sys.argv[1]))
    payload = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    lines = json.loads(payload["lines"])
    total = len(loud) * FRAME

    def slice_of(begin: float, end: float) -> numpy.ndarray:
        a, b = int(begin / FRAME), max(int(begin / FRAME) + 1, int(end / FRAME))
        return loud[a:b]

    def level(begin: float, end: float) -> float:
        """그 구간의 대표 세기. 가운뎃값이라 짧은 튐에 흔들리지 않는다."""
        window = slice_of(begin, end)
        return float(numpy.median(window)) if len(window) else -100.0

    def dip(begin: float, end: float) -> float:
        """가장 조용했던 순간. 숨은 짧아서 가운뎃값에 묻힌다."""
        window = slice_of(begin, end)
        return float(numpy.min(window)) if len(window) else -100.0

    print(f"  보컬 {total:.0f}초 · 줄 {len(lines)}개")
    head, tail = lines[0][0] / 1000, lines[-1][1] / 1000
    print(f"  전주 {level(0, head):>5.0f}dB · 노래 {level(head, tail):>5.0f}dB · 후주 {level(tail, total):>5.0f}dB\n")

    print("  ── 줄 사이의 틈이 얼마나 내려앉는가 ──")
    print(f"  {'앞줄':>4}{'틈':>16}{'폭':>7}{'양옆':>8}{'틈바닥':>8}{'내려앉음':>10}")
    print("  " + "─" * 62)
    drops: list[float] = []
    flat: list[int] = []
    for index in range(len(lines) - 1):
        begin, end = lines[index][1] / 1000, lines[index + 1][0] / 1000
        width = end - begin
        if width < 0.2:
            continue
        # 양옆 줄의 세기. 틈에 가까운 1.5초씩만 본다 — 줄 전체를 재면 먼 곳의 셈여림이 섞인다.
        before = level(max(lines[index][0] / 1000, begin - 1.5), begin)
        after = level(end, min(lines[index + 1][1] / 1000, end + 1.5))
        around = max(before, after)
        bottom = dip(begin, end)
        drop = around - bottom
        drops.append(drop)
        mark = ""
        if drop < BREATH_DROP:
            mark = "  ← 숨 쉬는 자리가 아님"
            flat.append(index)
        print(f"  {index:>4}{begin:>8.2f}~{end:<8.2f}{width:>6.1f}s{around:>7.0f}dB{bottom:>7.0f}dB{drop:>8.0f}dB{mark}")

    print("\n  ── 정리 ──")
    if drops:
        ordered = sorted(drops)
        print(f"  잰 틈 {len(drops)}개 · 내려앉는 폭 가운뎃값 {ordered[len(ordered) // 2]:.0f}dB · 가장 얕은 곳 {ordered[0]:.0f}dB")
        print(f"  숨 쉬는 자리로 보이는 틈 {len(drops) - len(flat)}/{len(drops)}")
        if flat:
            print(f"  아닌 곳: 줄 {flat}")


if __name__ == "__main__":
    main()
