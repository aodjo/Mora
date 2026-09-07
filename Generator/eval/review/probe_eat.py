#!/usr/bin/env python3
"""**앞 줄 꼬리가 다음 줄 머리를 먹는가.** 받아쓰기가 다음 줄 첫 낱말을 들은 시각(못)을 기준으로,
검수 서버에 저장된 정렬에서 (1) 앞 줄 마지막 낱말이 그 시각보다 늦게 시작하는 줄, (2) 다음 줄 첫
낱자가 그 시각보다 문턱 넘게 늦은 줄을 센다.

@example
  python probe_eat.py            # 서버의 모든 곡
  python probe_eat.py 12 8       # 이 곡들만
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
LATE_MS = 600


def main() -> int:
    """Report per song how often a tail runs past the next line's heard head.

    @returns {int} 0 always.
    """
    conn = sqlite3.connect(os.environ.get("MORA_DB", "review.db"))
    conn.row_factory = sqlite3.Row
    want = [int(one) for one in sys.argv[1:]]
    rows = conn.execute("SELECT * FROM songs ORDER BY id").fetchall()
    total = {"줄": 0, "꼬리 침범": 0, "머리 늦음": 0, "둘 다": 0}
    for row in rows:
        if want and row["id"] not in want:
            continue
        lines = json.loads(row["lines"])
        found = align.source_in(align.Path("audio"), row["video_id"])
        heard = align.kept(align.beside(found, ".heard.json"))
        if not heard or (heard.get("닮은 만큼") or 0) < align.HEARD_TRUST_ALIKE:
            print(f"  [{row['id']:>2}] {row['title'][:14]:<14} 받아쓰기 없음/못 믿음")
            continue
        said = [(word, at) for word, at in heard["낱말"]]
        pins = pins_of(lines, said)
        got = json.load(urllib.request.urlopen(f"{BASE}/api/songs/{row['id']}"))
        eaten = late = both = seen = 0
        shown = 0
        for index in range(1, len(lines)):
            when = pins.get((index, 0))
            if when is None:
                continue
            before = [c for w in (got["lines"][index - 1].get("words") or []) for c in (w.get("chars") or []) if c.get("at") is not None]
            head = [c for w in (got["lines"][index].get("words") or []) for c in (w.get("chars") or []) if c.get("at") is not None]
            if not before or not head:
                continue
            seen += 1
            last_word = (got["lines"][index - 1].get("words") or [])[-1]
            tail_late = last_word["at"] > when + 200
            head_late = head[0]["at"] > when + LATE_MS
            eaten += tail_late
            late += head_late
            both += tail_late and head_late
            if tail_late and shown < 4:
                shown += 1
                print(f"      [{index - 1:>2}→{index:>2}] 앞 줄 끝 낱말 「{last_word['text']}」 {last_word['at'] / 1000:.2f}"
                      f" · 다음 줄 못 {when / 1000:.2f} · 다음 줄 머리 {head[0]['at'] / 1000:.2f}"
                      f"  ({(head[0]['at'] - when) / 1000:+.2f}s)")
        print(f"  [{row['id']:>2}] {row['title'][:14]:<14} 못 있는 줄 {seen:>3} · 꼬리가 다음 못 넘음 {eaten:>3}"
              f" · 머리 {LATE_MS}ms 넘게 늦음 {late:>3} · 둘 다 {both:>3}")
        total["줄"] += seen
        total["꼬리 침범"] += eaten
        total["머리 늦음"] += late
        total["둘 다"] += both
    print(f"\n  통틀어 {total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
