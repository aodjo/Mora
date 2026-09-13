#!/usr/bin/env python3
"""**쌩 가사로 맞춘 결과를 검수 화면에 넣어, 사람이 들어 보게 한다.**

probe_blind 는 줄 시작만 재고 결과를 버린다. 그런데 0.5 초 자로 28/28 이던 곡을 사람이 듣자마자
「첫 줄부터 틀렸다」고 했다 — 줄 안의 글자가 1.5 초 늘어져 있었다. 숫자로 안 보이는 것은 들어야 안다.

곡마다 줄 시각을 떼고 `align_voices` 로 맞춘 다음, 서버의 「다시 맞추기」와 똑같이 놓인 줄의 낱말만
바꿔 넣는다. 줄의 시각(at)·판정·메모는 건드리지 않는다. 쓰기 전에 review.db 를 통째로 떠 둔다.

@example
  python listen_blind.py 1 9 10                                   # 원래 MMS
  MORA_MMS_WEIGHTS=~/mora-train/models/mms_sing_b.pt python listen_blind.py   # 학습한 무게, 열한 곡
"""
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402
from probe_blind import starts, words_of  # noqa: E402


def main() -> int:
    """Align the named songs blind and write their words into the review database.

    @returns {int} 0 always.
    """
    where = HERE / os.environ.get("MORA_DB", "review.db")
    conn = sqlite3.connect(where)
    conn.row_factory = sqlite3.Row
    wanted = [int(one) for one in sys.argv[1:]]
    rows = conn.execute("SELECT id, title, video_id, lines FROM songs ORDER BY id").fetchall()
    rows = [row for row in rows if row["id"] in wanted] if wanted else rows[:11]

    keep = where.with_name(f"{where.name}.bak-{time.strftime('%Y%m%d-%H%M%S')}")
    with sqlite3.connect(keep) as copy:
        conn.backup(copy)
    print(f"  떠 둔 것 {keep.name} · 무게 {align.MMS_WEIGHTS or '원래 MMS'} · 시계 {align.CLOCK_FROM}\n")

    for row in rows:
        found = align.source_in(HERE / "audio", row["video_id"])
        if not found:
            print(f"  [{row['id']}] {row['title'][:16]} — 음원 없음")
            continue
        began = time.time()
        lines = json.loads(row["lines"])
        out, lanes = align.align_voices(found, [{**one, "at": None} for one in lines], words_of, row["title"])
        said = {index: one["at"] for index, one in enumerate(lines) if one.get("at") is not None}
        got = starts(out)
        off = sorted((got[index] - said[index]) / 1000 for index in got if index in said)
        score = ""
        if off:
            mid = off[len(off) // 2]
            score = (f" · 0.5초 안 {sum(1 for one in off if abs(one - mid) <= 0.5)}/{len(off)}"
                     f" · 0.25초 안 {sum(1 for one in off if abs(one - mid) <= 0.25)}/{len(off)}")
        placed = [{**line, "words": out[index], "lane": lanes.get(index, 0)} if out[index] else line
                  for index, line in enumerate(lines)]
        with conn:
            conn.execute("UPDATE songs SET lines=? WHERE id=?", (json.dumps(placed, ensure_ascii=False), row["id"]))
        print(f"  [{row['id']}] {row['title'][:16]:<16}{score} · {time.time() - began:.0f}초", flush=True)
    print(f"\n  되돌리려면 서버를 끄고: cp {keep} {where}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
