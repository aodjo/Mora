"""줄의 마지막 낱자가 소리가 멎기 전에 꺼지는지, 멎은 뒤까지 켜져 있는지 잰다 — 장음 처리.

리드 갈래의 숨(REST_DB 아래로 REST_MS 넘게)을 「목소리가 멎은 자리」로 본다. 줄의 끝이 그보다
많이 이르면 장음이 잘린 것이고, 많이 늦으면 다음 줄이 시작했는데도 앞 줄이 켜져 있는 것이다.

    MORA_MMS_WEIGHTS=… MORA_TAIL_HOLD_MS=0 python probe_tails.py review.db 11   # 예전 동작
    MORA_MMS_WEIGHTS=… python probe_tails.py review.db 11                        # 지금 동작
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402
from probe_blind import words_of  # noqa: E402

#: 이만큼 넘게 어긋나야 문제로 센다(ms).
SLACK = 400


def main() -> int:
    """Align each song blind and count early and late line tails.

    @returns {int} 0 always.
    """
    db, count = Path(sys.argv[1]), int(sys.argv[2])
    rows = sqlite3.connect(db).execute("SELECT id, title, video_id, lines FROM songs ORDER BY id").fetchall()[:count]
    early = late = tails = 0
    for song_id, title, video, raw in rows:
        lines = json.loads(raw)
        if sum(1 for one in lines if one.get("at") is not None) < 8:
            continue
        found = align.source_in(db.parent / "audio", video)
        began = time.time()
        out, _ = align.align_voices(found, [{**one, "at": None} for one in lines], words_of, title)
        breaths = align.rest_ends(found.with_suffix(".lead.wav"))
        song_early = song_late = song_tails = 0
        holds: list[int] = []
        for words in out:
            chars = [one for word in words for one in (word.get("chars") or []) if one.get("at") is not None]
            if not chars:
                continue
            last = chars[-1]
            stop = next((since for since, _ in breaths if since >= last["at"] + 60), None)
            if stop is None:
                continue
            song_tails += 1
            holds.append((last.get("end") or last["at"]) - last["at"])
            if (last.get("end") or last["at"]) < stop - SLACK:
                song_early += 1
            elif (last.get("end") or last["at"]) > stop + SLACK:
                song_late += 1
        early, late, tails = early + song_early, late + song_late, tails + song_tails
        middle = sorted(holds)[len(holds) // 2] if holds else 0
        print(f"  [{song_id}] {title[:18]:<18} 줄 끝 {song_tails:>3} · 일찍 꺼짐 {song_early:>3} · 늦게 꺼짐 {song_late:>2} · "
              f"잡는 길이 가운데 {middle:>5}ms · {time.time() - began:.0f}초", flush=True)
    print(f"\n잡는 길이 {os.environ.get('MORA_TAIL_HOLD_MS', '4000')}ms 설정: 줄 끝 {tails} 가운데 일찍 꺼짐 {early} "
          f"({early / max(1, tails) * 100:.0f}%) · 늦게 꺼짐 {late}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
