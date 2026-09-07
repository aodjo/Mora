#!/usr/bin/env python3
"""**낱말 자리에서 누가 소리 위에 있나 — 우리 정렬인가, whisper 인가.** 받아쓴 낱말 못(`probe_pins`)
마다 우리 낱말 시각과 whisper 시각(그대로, 쏠림 더한 것)에서 가장 가까운 소리 솟음까지의 거리를 재고,
곡마다 어느 쪽이 더 자주 솟음 50 ms 안에 있는지 센다. 시트 시각이 있는 곡에서는 시트와의 차도 같이.

@example
  ./.venv/bin/python probe_who.py 12 9 8
"""
import json
import os
import sqlite3
import sys
import urllib.request

sys.path.insert(0, ".")
import align  # noqa: E402
from probe_pins import pins_of, tokenize  # noqa: E402

BASE = "http://127.0.0.1:8787"


def nearest(marks: list[int], at: int) -> int:
    """Distance from `at` to the closest onset.

    @param {list[int]} marks - Onset times, ascending.
    @param {int} at - A time in ms.
    @returns {int} Distance in ms, or a large number when there are no onsets.
    """
    if not marks:
        return 10 ** 9
    import bisect
    spot = bisect.bisect_left(marks, at)
    near = []
    if spot < len(marks):
        near.append(abs(marks[spot] - at))
    if spot > 0:
        near.append(abs(marks[spot - 1] - at))
    return min(near)


def main() -> int:
    """Per song, count who sits on the sound at the pinned words.

    @returns {int} 0 always.
    """
    conn = sqlite3.connect(os.environ.get("MORA_DB", "review.db"))
    conn.row_factory = sqlite3.Row
    for song_id in [int(one) for one in sys.argv[1:]]:
        row = conn.execute("SELECT * FROM songs WHERE id=?", (song_id,)).fetchone()
        lines = json.loads(row["lines"])
        found = align.source_in(align.Path("audio"), row["video_id"])
        heard = align.kept(align.beside(found, ".heard.json"))
        if not heard:
            print(f"  [{song_id}] 받아쓰기 없음")
            continue
        said = [(word, at) for word, at in heard["낱말"]]
        pins = pins_of(lines, said)
        lead = found.parent / (found.name.rsplit(".", 1)[0] + ".lead.wav")
        marks = align.onsets_of(lead)
        got = json.load(urllib.request.urlopen(f"{BASE}/api/songs/{song_id}"))
        rows = {"우리": [], "whisper": [], "whisper+쏠림": []}
        deltas = []
        for (index, spot), when in sorted(pins.items()):
            words = got["lines"][index].get("words") or []
            expect = ["".join(align.grains_of(align.speakable(w))) for w in tokenize(lines[index]["text"])]
            ours = None
            k = 0
            for wd in words:
                while k < len(expect) and expect[k] != wd["text"]:
                    k += 1
                if k == spot:
                    ours = wd["at"]
                    break
                k += 1
            if ours is None:
                continue
            raw = when - align.HEARD_LEAN_MS
            rows["우리"].append(nearest(marks, ours))
            rows["whisper"].append(nearest(marks, raw))
            rows["whisper+쏠림"].append(nearest(marks, when))
            deltas.append(ours - raw)
        n = len(deltas)
        if not n:
            print(f"  [{song_id}] 못 없음")
            continue
        deltas.sort()
        print(f"  [{song_id:>2}] {row['title'][:14]:<14} 못 {n:>3} · 우리 − whisper 가운뎃값 {deltas[n // 2]:+5d} ms"
              f" (사분위 {deltas[n // 4]:+5d} ~ {deltas[3 * n // 4]:+5d})")
        for key, dist in rows.items():
            close = sum(1 for one in dist if one <= 50)
            print(f"        {key:<12} 솟음 50ms 안 {close:>3}/{n} ({close * 100 // n}%)   100ms 안 {sum(1 for one in dist if one <= 100):>3}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
