#!/usr/bin/env python3
"""**probe_blind 를 곡마다 따로 된 프로세스로 나란히 돌린다.** 셈은 probe_blind 와 똑같다.

맥에서는 열한 곡을 차례로 돌려 몇 분씩 걸렸다. CPU 가 많고 GPU 가 한 장인 빌린 기계에서는 곡마다
프로세스를 하나씩 띄우면 가장 긴 곡 하나만큼만 기다리면 된다. 한 프로세스가 MMS(1.2 GB)와 다듬기
(Qwen3, 딴 살림)를 따로 올리므로 GPU 메모리가 곡 수만큼 든다 — `MORA_PAR` 로 한꺼번에 몇 곡을
돌릴지 정한다.

@example
  python probe_par.py 11                                   # 열한 곡, 시각 있음 · 쌩 가사
  MORA_MMS_WEIGHTS=~/mora-train/models/mms_sing_b.pt MORA_CLOCK=model python probe_par.py 11 --blind
"""
import json
import multiprocessing
import os
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))


def piled(out: list[list[dict]], lanes: dict[int, int]) -> int:
    """Count lines whose last syllable lights after the next line of the same voice has started.

    The screen has already moved to the next line by then, so the previous line's tail flashes up
    behind it — what a person hears as lyrics piling on each other.

    @param {list[list[dict]]} out - Per-line word dicts with character times.
    @param {dict[int, int]} lanes - Voice lane per line.
    @returns {int} How many lines pile onto the next.
    """
    timed = [[one for word in words for one in (word.get("chars") or []) if one.get("at") is not None]
             for words in out]
    count = 0
    for index, chars in enumerate(timed):
        if not chars:
            continue
        later = next((one for one in range(index + 1, len(out))
                      if timed[one] and lanes.get(one, 0) == lanes.get(index, 0)), None)
        if later is not None and chars[-1]["at"] >= timed[later][0]["at"]:
            count += 1
    return count


def one_song(job: tuple[dict, bool]) -> dict:
    """Align one song with and without its outside times and score it the way probe_blind does.

    @param {tuple[dict, bool]} job - The song row, and whether to skip the with-times pass.
    @returns {dict} The song's id, title, and per-pass `(hit, lines, mid, spread, near, onset, broke, tight, pile)`.
    """
    import align
    from probe_blind import starts, words_of
    from probe_onset import NEAR_MS, nearest, onsets_of

    row, blind_only = job
    found = align.source_in(HERE / "audio", row["video_id"])
    lines = json.loads(row["lines"])
    said = {index: one["at"] for index, one in enumerate(lines) if one.get("at") is not None}
    marks = onsets_of(found.with_suffix(".lead.wav"))
    passes = [] if blind_only else [("시각 있음", lines)]
    passes.append(("쌩 가사", [{**one, "at": None} for one in lines]))
    got_all = {}
    for name, feed in passes:
        out, lanes = align.align_voices(found, feed, words_of, row["title"])
        got = starts(out)
        off = sorted((got[index] - said[index]) / 1000 for index in got if index in said)
        if not off:
            continue
        mid = off[len(off) // 2]
        hit = sum(1 for one in off if abs(one - mid) <= 0.5)
        #: 0.5 초 자는 귀에 들리는 0.3~0.4 초 늦음을 못 본다 — 사랑하게 될거야 첫 줄이 쉼 끝에 붙어
        #: 0.4 초 늦었는데 0.5 초 안으로 셌다. 그래서 0.25 초 안도 함께 센다.
        tight = sum(1 for one in off if abs(one - mid) <= 0.25)
        far = sorted(nearest(marks, one["at"]) for words in out for word in words
                     for one in (word.get("chars") or []) if one["at"] is not None)
        onset = sum(1 for one in far if one <= NEAR_MS) / len(far) if far else 0
        broke = sum(1 for one in out if one and one[0].get("stuck"))
        got_all[name] = (hit, len(off), mid, off[-1] - off[0], hit / len(off), onset, broke, tight, piled(out, lanes))
    return {"id": row["id"], "title": row["title"], "passes": got_all}


def main() -> int:
    """Run the benchmark songs in parallel and print probe_blind's table and totals.

    @returns {int} 0 always.
    """
    how_many = int(next((one for one in sys.argv[1:] if one.isdigit()), "11"))
    blind_only = "--blind" in sys.argv
    conn = sqlite3.connect(HERE / os.environ.get("MORA_DB", "review.db"))
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT id, artist, title, video_id, lines FROM songs ORDER BY id").fetchall()[:how_many]

    import align
    jobs = []
    for row in rows:
        found = align.source_in(HERE / "audio", row["video_id"])
        lines = json.loads(row["lines"])
        if not found or not found.with_suffix(".lead.wav").exists():
            continue
        if sum(1 for one in lines if one.get("at") is not None) < 8:
            continue
        jobs.append(({key: row[key] for key in row.keys()}, blind_only))

    print(f"  무게 {os.environ.get('MORA_MMS_WEIGHTS') or '원래 MMS'} · 시계 {align.CLOCK_FROM}"
          f" · 마스크 {'켬' if align.VOICE_MASK else '끔'} · 다듬기 경계 {align.POLISH_FENCE} · 줄 머리 {align.POLISH_HEAD}\n")
    print(f"  {'곡':<26} {'':>6} {'차':>7} {'폭':>7} {'0.5초 안':>7} {'소리 50ms':>8} {'무너짐':>5} {'0.25초 안':>8} {'겹침':>4}")
    with multiprocessing.get_context("spawn").Pool(int(os.environ.get("MORA_PAR", "8"))) as pool:
        done = pool.map(one_song, jobs)

    tally = {"시각 있음": [0, 0, 0, 0.0, 0, 0], "쌩 가사": [0, 0, 0, 0.0, 0, 0]}
    for song in done:
        for name, (hit, lines, mid, spread, near, onset, broke, tight, pile) in song["passes"].items():
            head = f"[{song['id']}] {song['title'][:16]}" if name == "시각 있음" or blind_only else ""
            print(f"  {head:<26} {name:>6} {mid:+6.2f}s {spread:6.1f}s {near * 100:>6.0f}% {onset * 100:>7.0f}% {broke:>5}"
                  f" {tight / lines * 100:>7.0f}% {pile:>4}")
            tally[name][0] += hit
            tally[name][1] += lines
            tally[name][2] += tight
            tally[name][3] += onset
            tally[name][4] += 1
            tally[name][5] += pile
    for name, (hit, all_of, tight, onset, songs, pile) in tally.items():
        if all_of:
            print(f"\n  {name}: 줄 {all_of} 가운데 제자리 {hit} ({hit / all_of * 100:.0f}%)"
                  f" · 0.25초 안 {tight} ({tight / all_of * 100:.0f}%) · 소리 50ms 곡 평균 {onset / songs * 100:.1f}%"
                  f" · 겹침 {pile}줄")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
