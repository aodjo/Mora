#!/usr/bin/env python3
"""**줄 끝 음절이 얼마나 오래 끌리나.** 다음 줄이 시작할 때까지 붙들고 있는 줄을 센다.

`loosen_chars` 는 낱자마다 끝을 다음 낱자가 시작하는 데까지 늘린다 — 줄 안에서는 옳다. 그런데
줄의 마지막 낱자에게 「다음 낱자」란 **다음 줄의 첫 낱자**여서, 그 사이 빈 틈을 통째로 붙들고
`HOLD_MS` 상한까지 간다. 보는 사람 눈에는 이전 가사가 안 끝나고 늘어지는 것으로 읽힌다.

여기서는 곡마다 끝 음절이 얼마나 버티는지, 1 초를 넘기는 줄이 몇이며 다음 줄까지 빈틈없이
채우는 줄이 몇인지를 센다. `hush_tails` 를 넣기 전과 넣은 뒤를 같은 자로 견주기 위한 것이다.

@example
  python probe_tail.py
"""
import json
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

#: 어디서 읽나.
BASE = "http://127.0.0.1:8787"
#: 이보다 오래 끌면 눈에 띈다(ms).
LONG_MS = 1000
#: 다음 줄 첫 낱자와 이만큼 안이면 「빈틈없이 채웠다」고 본다(ms).
FULL_MS = 80


def tails(lines: list[dict]) -> list[tuple[int, bool]]:
    """How long each line's last syllable holds, and whether it runs into the next line.

    @param {list[dict]} lines - Served lines with words and chars.
    @returns {list[tuple[int, bool]]} Hold length in ms, and whether it reaches the next line.
    """
    rows: list[tuple[int, bool]] = []
    marks = [[one for word in (line.get("words") or [])
              for one in (word.get("chars") or []) if one.get("at") is not None]
             for line in lines]
    for at, chars in enumerate(marks):
        if not chars:
            continue
        last = chars[-1]
        held = (last.get("end") or last["at"]) - last["at"]
        after = next((two[0]["at"] for two in marks[at + 1:] if two), None)
        rows.append((held, after is not None and after - (last.get("end") or last["at"]) <= FULL_MS))
    return rows


def main() -> int:
    """Print per-song tail-hold statistics.

    @returns {int} 0 always.
    """
    with urllib.request.urlopen(f"{BASE}/api/songs", timeout=60) as got:
        songs = sorted(json.load(got), key=lambda one: one["id"])
    every: list[int] = []
    late = full = 0
    print(f"  {'곡':<26} {'줄':>4} {'가운뎃값':>8} {'1초 넘김':>8} {'꽉 채움':>8}")
    for song in songs:
        with urllib.request.urlopen(f"{BASE}/api/songs/{song['id']}", timeout=60) as got:
            rows = tails(json.load(got)["lines"])
        if not rows:
            continue
        held = sorted(one for one, _ in rows)
        every.extend(held)
        late += sum(1 for one in held if one > LONG_MS)
        full += sum(1 for _, one in rows if one)
        print(f"  [{song['id']:>2}] {song['title'][:18]:<20} {len(rows):>4} {held[len(held) // 2]:>6}ms "
              f"{sum(1 for one in held if one > LONG_MS):>8} {sum(1 for _, one in rows if one):>8}")
    every.sort()
    print(f"\n  끝음절 {len(every)}개 · 가운뎃값 {every[len(every) // 2]}ms · "
          f"1초 넘김 {late} · 다음 줄까지 꽉 채움 {full}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
