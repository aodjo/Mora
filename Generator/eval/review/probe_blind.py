#!/usr/bin/env python3
"""**밖에서 온 줄 시각 없이, 쌩 가사만으로 얼마나 맞추는가.**

지금까지의 자는 모두 바이브 시각이 있는 채로 잰 것이다. 그런데 파는 물건은 시각 없는 가사에도
서야 한다 — 가사만 있고 시각이 없는 곡이 훨씬 많다.

시각을 떼고 맞춘 다음, 떼어 둔 그 시각과 견준다. 그것을 **정답으로 삼는 것이 아니라** 가진 자
가운데 가장 촘촘한 것이라 쓴다(열 곡에서 줄 시작이 ±0.6 초 안이었다). 함께 소리 세기가 솟는
자리와도 견주므로, 바이브가 틀린 곡에서도 한쪽 눈은 열려 있다.

시각을 떼면 무엇이 꺼지는가:

  * `settle_clock` — 곡의 시계를 못 재니 아무 줄도 안 되돌린다
  * `rethink` 의 못 박기 — 밖 시각이 있어야 어디에 박을지 안다
  * 앞머리 막기(`HEAD_ROOM_MS`) — 첫 줄이 언제인지 모른다

남는 것은 CTC 자체와 **화자 자르기 마스크**, 그리고 펴기·다듬기다.

@example
  python probe_blind.py 11        # 열한 곡
  MORA_VOICE_MASK=0 python probe_blind.py 11
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
from probe_onset import NEAR_MS, nearest, onsets_of  # noqa: E402

NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")


def words_of(text: str) -> list[str]:
    """Split a line into the words the aligner uses, dropping marks that carry no sound.

    @param {str} text - One lyric line.
    @returns {list[str]} Words worth aligning.
    """
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def starts(out: list[list[dict]]) -> dict[int, int]:
    """First character time of every line that got one.

    @param {list[list[dict]]} out - Per-line word dicts.
    @returns {dict[int, int]} Line index to start in ms.
    """
    got: dict[int, int] = {}
    for index, words in enumerate(out):
        chars = [one for word in words for one in (word.get("chars") or []) if one["at"] is not None]
        if chars:
            got[index] = chars[0]["at"]
    return got


def main() -> int:
    """Align each song twice — with the outside times and without — and print both side by side.

    @returns {int} 0 always.
    """
    #: 다른 기계에서 잴 때는 그 기계의 검수 기록을 덮지 않고 옮겨 온 사본을 따로 읽는다.
    conn = sqlite3.connect(HERE / os.environ.get("MORA_DB", "review.db"))
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT id, artist, title, video_id, lines FROM songs ORDER BY id").fetchall()
    how_many = int(sys.argv[1]) if len(sys.argv) > 1 else 11
    print(f"  마스크 {'켬' if align.VOICE_MASK else '끔'}\n")
    print(f"  {'곡':<26} {'':>6} {'차':>7} {'폭':>7} {'0.5초 안':>7} {'소리 50ms':>8} {'무너짐':>5}")

    tally = {"with": [0, 0], "blind": [0, 0]}
    for row in rows[:how_many]:
        found = align.source_in(HERE / "audio", row["video_id"])
        if not found or not found.with_suffix(".lead.wav").exists():
            continue
        lines = json.loads(row["lines"])
        said = {index: one["at"] for index, one in enumerate(lines) if one.get("at") is not None}
        if len(said) < 8:
            continue
        marks = onsets_of(found.with_suffix(".lead.wav"))

        for name, feed in (("시각 있음", lines),
                           ("쌩 가사", [{**one, "at": None} for one in lines])):
            out, _ = align.align_voices(found, feed, words_of, row["title"])
            got = starts(out)
            off = sorted((got[index] - said[index]) / 1000 for index in got if index in said)
            if not off:
                continue
            mid = off[len(off) // 2]
            near = sum(1 for one in off if abs(one - mid) <= 0.5) / len(off)
            far = sorted(nearest(marks, one["at"]) for words in out for word in words
                         for one in (word.get("chars") or []) if one["at"] is not None)
            hit = sum(1 for one in far if one <= NEAR_MS) / len(far) if far else 0
            broke = sum(1 for one in out if one and one[0].get("stuck"))
            key = "with" if name == "시각 있음" else "blind"
            tally[key][0] += sum(1 for one in off if abs(one - mid) <= 0.5)
            tally[key][1] += len(off)
            #: 줄마다의 결과를 남긴다 — 어느 줄이 왜 빠지는지는 곡 평균으로는 안 보인다.
            if os.environ.get("MORA_BLIND_DUMP") and key == "blind":
                rows_out = []
                for index, words in enumerate(out):
                    chars = [one for word in words for one in (word.get("chars") or []) if one.get("at") is not None]
                    gaps = [b["at"] - a["at"] for a, b in zip(chars, chars[1:])]
                    rows_out.append({
                        "index": index, "text": lines[index].get("text", ""),
                        "sheet": said.get(index), "ours": chars[0]["at"] if chars else None,
                        "last": chars[-1]["at"] if chars else None, "n": len(chars),
                        "flat": sorted({one.get("flat") for one in chars if one.get("flat")}),
                        "gap_min": min(gaps) if gaps else None, "gap_max": max(gaps) if gaps else None,
                        "sure": round(min((one.get("sure", 0.0) for one in chars), default=0.0), 1),
                        "lane": (words[0].get("lane") if words else None),
                    })
                with open(os.environ["MORA_BLIND_DUMP"], "a", encoding="utf-8") as fh:
                    fh.write(json.dumps({"id": row["id"], "title": row["title"], "mid": mid, "lines": rows_out},
                                        ensure_ascii=False) + "\n")
            head = f"[{row['id']}] {row['title'][:16]}" if name == "시각 있음" else ""
            print(f"  {head:<26} {name:>6} {mid:+6.2f}s {off[-1] - off[0]:6.1f}s "
                  f"{near * 100:>6.0f}% {hit * 100:>7.0f}% {broke:>5}", flush=True)

    for key, name in (("with", "시각 있음"), ("blind", "쌩 가사")):
        hit, all_of = tally[key]
        if all_of:
            print(f"\n  {name}: 줄 {all_of} 가운데 제자리 {hit} ({hit / all_of * 100:.0f}%)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
