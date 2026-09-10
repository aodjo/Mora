#!/usr/bin/env python3
"""**무너진 구간에서 누가 틀렸나 — 시계인가 CTC 인가.** `probe_blind` 의 줄별 기록(`MORA_BLIND_DUMP`)과
그 곡의 `.clock.json` 을 나란히 놓고, 구간의 줄마다 시트 시각 · 지어낸 시계(못박힌 줄은 *) · 우리 자리 ·
어긋남 · 잔해 자국을 찍는다.

@example
  ./.venv/bin/python probe_region.py blind18.jsonl 10:60-99 9:40-52
"""
import glob
import json
import os
import sqlite3
import sys


def main() -> int:
    """Print the region tables asked for on the command line.

    @returns {int} 0 always.
    """
    conn = sqlite3.connect(os.environ.get("MORA_DB", "review.db"))
    dumps = {}
    for raw in open(sys.argv[1], encoding="utf-8"):
        one = json.loads(raw)
        dumps[one["id"]] = one
    for spec in sys.argv[2:]:
        song_id, span = spec.split(":")
        lo, hi = (int(x) for x in span.split("-"))
        song_id = int(song_id)
        vid, title = conn.execute("SELECT video_id, title FROM songs WHERE id=?", (song_id,)).fetchone()
        dump = dumps[song_id]
        clock = json.load(open(glob.glob(f"audio/{vid}*.clock.json")[0], encoding="utf-8"))
        heard = json.load(open(glob.glob(f"audio/{vid}*.heard.json")[0], encoding="utf-8"))
        pinned = set(clock.get("못박힌 줄") or [])
        print(f"== [{song_id}] {title}  닮음 {heard.get('닮은 만큼')} 믿나 {clock.get('받아쓰기를 믿나')}"
              f" 급한 못 {clock.get('급한 못')}  곡 어긋남 {dump['mid']:+.2f}s")
        for row in dump["lines"][lo:hi + 1]:
            index = row["index"]
            tick = clock["시계"][index] if index < len(clock["시계"]) else None
            sheet, ours = row["sheet"], row["ours"]
            off = ((ours - sheet) / 1000 - dump["mid"]) if (ours is not None and sheet is not None) else 0.0
            print(f"  [{index:>2}] 시트 {(sheet or 0) / 1000:6.1f}  시계 {(tick or 0) / 1000:6.1f}{'*' if index in pinned else ' '}"
                  f"  우리 {(ours or 0) / 1000:6.1f}  차 {off:+5.1f}  {','.join(row['flat']) or '-':<6} {row['text'][:24]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
