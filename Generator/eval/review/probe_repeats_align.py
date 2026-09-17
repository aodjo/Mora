"""반복을 되살린 가사로 맞추면 정답 줄 가운데 몇 줄이 제자리에 서는지, 줄인 가사로 맞출 때와 견준다.

곡마다 두 번 맞춘다 — 멜론식으로 줄인 가사 그대로(`줄임`), 받아쓰기로 반복을 되살린 가사(`되살림`).
맞춘 줄을 정답(바이브)의 같은 글 줄과 순서대로 짝짓는다. 같은 글이 여러 번이면 어느 번과 짝지을지가
흔들리므로, 짝 수가 같으면 시각 차가 작은 쪽을 고른다(글이 한 번뿐인 줄로 먼저 곡의 어긋남을 잰다).

  제자리  정답 줄 가운데 곡 가운데값을 뺀 뒤 0.5 초·0.25 초 안에 선 줄 (분모는 시각 있는 정답 줄 전부)
  반복    그 가운데 줄인 가사에는 없는 반복 줄
  남는 줄 맞췄는데 정답의 어느 줄과도 짝이 안 된 줄 — 지어낸 반복

    MORA_MMS_WEIGHTS=… python probe_repeats_align.py review.db 11 [--only 1,4,6]
"""
from __future__ import annotations

import json
import sqlite3
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402
import repeat_fill  # noqa: E402
from probe_blind import starts, words_of  # noqa: E402
from probe_repeats import collapse, key  # noqa: E402


def pair(fed: list[str], got: dict[int, int], truth: list[str], sheet: list[int | None]) -> dict[int, int]:
    """Pair fed lines with truth lines of the same text, in order, most pairs first and then least time error.

    @param {list[str]} fed - The lines given to the aligner.
    @param {dict[int, int]} got - Fed index to its aligned start in ms.
    @param {list[str]} truth - The lines as sung.
    @param {list[int | None]} sheet - The truth's start per line.
    @returns {dict[int, int]} Fed index to truth index.
    """
    fk, tk = [key(one) for one in fed], [key(one) for one in truth]
    once = [j for j, k in enumerate(tk) if tk.count(k) == 1]
    shift = sorted(got[i] - sheet[j] for i, k in enumerate(fk) if i in got and fk.count(k) == 1
                   for j in once if tk[j] == k and sheet[j] is not None)
    offset = shift[len(shift) // 2] if shift else 0
    n, m = len(fk), len(tk)
    #: (짝 수, -시각 차) 를 키운다.
    best = [[(0, 0.0)] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            options = [best[i + 1][j], best[i][j + 1]]
            if fk[i] == tk[j]:
                error = abs(got[i] - offset - sheet[j]) / 1000 if i in got and sheet[j] is not None else 30.0
                pairs_, cost = best[i + 1][j + 1]
                options.append((pairs_ + 1, cost - error))
            best[i][j] = max(options)
    paired: dict[int, int] = {}
    i = j = 0
    while i < n and j < m:
        if fk[i] == tk[j]:
            error = abs(got[i] - offset - sheet[j]) / 1000 if i in got and sheet[j] is not None else 30.0
            pairs_, cost = best[i + 1][j + 1]
            if best[i][j] == (pairs_ + 1, cost - error):
                paired[i] = j
                i, j = i + 1, j + 1
                continue
        if best[i][j] == best[i + 1][j]:
            i += 1
        else:
            j += 1
    return paired


def tally(got: dict[int, int], paired: dict[int, int], sheet: list[int | None], extra: set[int], fed: int) -> dict[str, int]:
    """Hits against the sheet with the song's median offset removed.

    @param {dict[int, int]} got - Fed index to its start in ms.
    @param {dict[int, int]} paired - Fed index to truth index.
    @param {list[int | None]} sheet - The truth's start per line.
    @param {set[int]} extra - Truth indices of the repeats a shortening provider drops.
    @param {int} fed - How many lines were fed.
    @returns {dict[str, int]} lines · hit · tight · repeats · repeat hit · repeat tight · unpaired.
    """
    counts = {"lines": sum(1 for at in sheet if at is not None), "hit": 0, "tight": 0,
              "repeats": sum(1 for j in extra if sheet[j] is not None), "rhit": 0, "rtight": 0,
              "unpaired": fed - len(paired)}
    offs = [(truth, (got[i] - sheet[truth]) / 1000) for i, truth in paired.items() if i in got and sheet[truth] is not None]
    if not offs:
        return counts
    mid = sorted(off for _, off in offs)[len(offs) // 2]
    for truth, off in offs:
        near, tight = abs(off - mid) <= 0.5, abs(off - mid) <= 0.25
        counts["hit"] += near
        counts["tight"] += tight
        if truth in extra:
            counts["rhit"] += near
            counts["rtight"] += tight
    return counts


def main() -> int:
    """Align each song with repeats shortened and recovered, and print per-song rows and totals.

    @returns {int} 0 always.
    """
    db, count = Path(sys.argv[1]), int(sys.argv[2])
    only = None
    if "--only" in sys.argv:
        only = {int(one) for one in sys.argv[sys.argv.index("--only") + 1].split(",")}
    rows = sqlite3.connect(db).execute("SELECT id, title, video_id, lines FROM songs ORDER BY id").fetchall()[:count]
    total: dict[str, dict[str, int]] = {"줄임": {}, "되살림": {}}
    for song_id, title, video, raw in rows:
        if only is not None and song_id not in only:
            continue
        lines = json.loads(raw)
        truth = [one["text"] for one in lines]
        sheet = [one.get("at") for one in lines]
        kept = collapse(truth)
        if len(kept) == len(truth) and only is None:
            continue
        extra = set(range(len(truth))) - set(kept)
        found = align.source_in(db.parent / "audio", video)
        heard = json.load(open(found.with_suffix(".heard.json"), encoding="utf-8"))["낱말"]
        short = [truth[k] for k in kept]
        order = repeat_fill.expand(short, [(w, at) for w, at in heard])
        cells = []
        for name, fed in {"줄임": short, "되살림": [short[k] for k in order]}.items():
            began = time.time()
            out, _ = align.align_voices(found, [{"text": text, "at": None} for text in fed], words_of, title)
            got = starts(out)
            counts = tally(got, pair(fed, got, truth, sheet), sheet, extra, len(fed))
            for field, value in counts.items():
                total[name][field] = total[name].get(field, 0) + value
            cells.append(f"{name} {counts['hit']}/{counts['tight']}/{counts['lines']} 반복 {counts['rhit']}/{counts['rtight']}/"
                         f"{counts['repeats']} 남는 {counts['unpaired']} {time.time() - began:.0f}초")
        print(f"[{song_id}] {title[:16]:<16} 넣은 {len(order) - len(short):>2} | " + " | ".join(cells), flush=True)
    for name, c in total.items():
        if c:
            print(f"{name}: 정답 줄 {c['lines']} 가운데 0.5초 {c['hit']} · 0.25초 {c['tight']} · 반복 줄 {c['repeats']} 가운데 "
                  f"0.5초 {c['rhit']} · 0.25초 {c['rtight']} · 남는 줄 {c['unpaired']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
