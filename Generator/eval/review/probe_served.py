#!/usr/bin/env python3
"""**서버가 낸 결과를 그대로 읽어 세 자를 한 번에 잰다.** 다시 맞추지 않는다.

앞의 세 프로브(`probe_onset`·`probe_stuck`·`probe_clock`)는 **각각** 열 곡을 처음부터 다시
맞춘다. 곡 하나 35 초면 한 벌 6 분, 세 벌 18 분 — 그리고 오늘 그것을 여섯 번 돌렸다. 자를 하나
더 대는 데 정렬을 세 번 하는 것은 낭비다.

여기서는 서버 API 에서 곡을 받아 그 위에서 잰다:

  * 낱자 ↔ 소리 솟는 자리 — 리드 갈래의 세기가 솟는 자리와 낱자마다의 거리
  * 무너진 줄 — 서버가 붙인 `stuck`
  * 시계 — 줄 시작과 바이브의 차이. 곡의 흩어짐이 좁을 때 문턱을 넘는 줄
  * 뒤집힘 · 포개짐 — 줄 순서가 거꾸로인 자리, 낱자가 한 순간에 겹친 줄

서버의 결과가 곧 사람이 보는 것이므로, 이것이 가장 정직한 자이기도 하다.

@example
  python probe_served.py            # http://127.0.0.1:8787
"""
import json
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402
from probe_onset import NEAR_MS, nearest, onsets_of  # noqa: E402

#: 어디서 읽나.
BASE = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].startswith("http") else "http://127.0.0.1:8787"


def fetch(path: str):
    """Read one JSON answer from the server.

    @param {str} path - Path under `BASE`.
    @returns {object} The decoded answer.
    """
    with urllib.request.urlopen(BASE + path, timeout=60) as got:
        return json.load(got)


def main() -> int:
    """Measure every served song and print one row each plus the totals.

    @returns {int} 0 always.
    """
    songs = fetch("/api/songs")
    songs = sorted(songs, key=lambda one: one["id"])
    print(f"  {'곡':<26} {'낱자':>5} {'소리 50ms 안':>9} {'가운뎃값':>6} {'무너짐':>4} {'튐':>3} {'뒤집힘':>4} {'포갬':>3}")
    every: list[int] = []
    totals = {"broke": 0, "stray": 0, "back": 0, "flat": 0, "lines": 0}
    for song in songs:
        full = fetch(f"/api/songs/{song['id']}")
        lines = full["lines"]
        found = align.source_in(HERE / "audio", song["video_id"])
        if not found or not found.with_suffix(".lead.wav").exists():
            continue
        marks = onsets_of(found.with_suffix(".lead.wav"))

        starts: list[tuple[int, int]] = []
        far: list[int] = []
        broke = flat = 0
        for index, line in enumerate(lines):
            chars = [one for word in (line.get("words") or []) for one in (word.get("chars") or [])
                     if one.get("at") is not None]
            if not chars:
                continue
            starts.append((index, chars[0]["at"]))
            far.extend(nearest(marks, one["at"]) for one in chars)
            broke += bool((line.get("words") or [{}])[0].get("stuck"))
            flat += any(b["at"] - a["at"] <= 0 for a, b in zip(chars, chars[1:]))
        if not far:
            continue

        off = [at - lines[index]["at"] for index, at in starts if lines[index].get("at") is not None]
        stray = 0
        if len(off) >= align.CLOCK_LEAST:
            mid = sorted(off)[len(off) // 2]
            apart = sorted(abs(one - mid) for one in off)
            scatter = apart[len(apart) // 2]
            if scatter <= align.CLOCK_TIGHT_MS:
                limit = max(align.CLOCK_APART_LEAST_MS, scatter * align.CLOCK_APART_TIMES)
                stray = sum(1 for one in off if abs(one - mid) > limit)
        back = sum(1 for (_, a), (_, b) in zip(starts, starts[1:]) if b < a)

        far.sort()
        every.extend(far)
        within = sum(1 for one in far if one <= NEAR_MS) / len(far)
        totals["broke"] += broke
        totals["stray"] += stray
        totals["back"] += back
        totals["flat"] += flat
        totals["lines"] += len(lines)
        print(f"  [{song['id']:>2}] {song['title'][:18]:<20} {len(far):>5} {within * 100:>8.0f}% "
              f"{far[len(far) // 2]:>4}ms {broke:>4} {stray:>3} {back:>4} {flat:>3}")

    if every:
        every.sort()
        print(f"\n  낱자 {len(every)} · 소리 50ms 안 {sum(1 for one in every if one <= NEAR_MS) / len(every) * 100:.0f}%"
              f" · 가운뎃값 {every[len(every) // 2]}ms · 무너짐 {totals['broke']}/{totals['lines']}"
              f" · 튐 {totals['stray']} · 뒤집힘 {totals['back']} · 포갬 {totals['flat']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
