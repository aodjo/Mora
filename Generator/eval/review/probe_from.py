#!/usr/bin/env python3
"""**목소리 자국을 어느 갈래에서 떠야 사람이 갈리는가.**

줄마다 그 줄이 실제로 울린 갈래에서 자국을 뜨게 고쳤더니 Small girl 은 0/6 에서 6/6 이
되었는데, 같은 때 빅뱅 「붉은 노을」 은 19 줄 갈리던 것이 통째로 한 레인이 되었다. 둘 다
여럿이 부르는 곡이므로 한쪽을 맞히려고 다른 쪽을 버린 셈이다.

여기서는 `who_sings` 를 세 가지 방식으로 각각 돌려 견준다 — 줄마다 제 갈래, 통째로 리드,
통째로 서브, 통째로 보컬. 정렬은 한 번만 하고 자국 뜨는 자리만 바꾸므로 다른 것이 섞이지
않는다.
"""
import json
import re
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402

NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")
SOLO = {1, 2, 4, 5, 6}
MANY = {3, 7, 8, 9}
#: Lines a person listened to and said another singer takes. Only Small girl has been checked by
#: ear this way, so it is the only song whose lane numbers can be called right or wrong.
TRUTH = {7: {18, 19, 20, 60, 61, 62}}


def words_of(text: str) -> list[str]:
    """Split a line into the words the aligner uses, dropping marks that carry no sound.

    @param {str} text - One lyric line.
    @returns {list[str]} Words worth aligning.
    """
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


held: dict[str, tuple] = {}
real = align.who_sings


def catch(from_stem, lines, out, title):
    """Stand in for `who_sings` to keep its arguments, then answer as usual.

    Alignment costs minutes a song, so the four ways of taking a voice print have to share one
    alignment or the comparison measures the wrong thing.

    @param {dict[int, Path]} from_stem - Which stem each line was aligned on.
    @param {list[dict]} lines - Lyric lines.
    @param {list[list[dict]]} out - Per-line word dicts.
    @param {str} title - Song title.
    @returns {list[int | None]} Whatever the real function answers.
    """
    held["args"] = (from_stem, lines, out, title)
    return real(from_stem, lines, out, title)


align.who_sings = catch

conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
rows = conn.execute("SELECT id, artist, title, video_id, lines FROM songs ORDER BY id").fetchall()
want = {int(one) for one in sys.argv[1:]} or (MANY | SOLO)

print(f"  {'곡':<30} {'여럿?':>4}  {'줄마다 제 갈래':>16} {'리드':>14} {'서브':>14} {'보컬':>14}")
for row in rows:
    if row["id"] not in want:
        continue
    found = align.source_in(HERE / "audio", row["video_id"])
    if not found or not found.with_suffix(".lead.wav").exists():
        continue
    lines = json.loads(row["lines"])
    align.align_voices(found, lines, words_of, row["title"])
    from_stem, lines, out, title = held["args"]

    said = []
    ways = [("제 갈래", None),
            ("리드", found.with_suffix(".lead.wav")),
            ("서브", found.with_suffix(".back.wav")),
            ("보컬", found.with_suffix(".vocals.wav"))]
    for _, stem in ways:
        mine = from_stem if stem is None else {index: stem for index in range(len(out))}
        for words in out:
            for word in words:
                word.pop("lane", None)
        who = real(mine, lines, out, title)
        tally: dict[int, int] = {}
        for one in who:
            if one is not None:
                tally[one] = tally.get(one, 0) + 1
        said.append((str(dict(sorted(tally.items()))) if len(tally) > 1 else "—", list(who)))

    name = f"[{row['id']}] {row['artist'][:8]} — {row['title'][:14]}"
    mark = "여럿" if row["id"] in MANY else "혼자"
    print(f"  {name:<30} {mark:>4}  " + " ".join(f"{one[0]:>14}" for one in said))
    if row["id"] in TRUTH:
        want = TRUTH[row["id"]]
        for (way, _), (_, who) in zip(ways, said):
            #: 레인마다 따로 견준다. 피처링 래퍼가 통째로 한 레인을 차지하므로 「0 이 아닌 줄」
            #: 을 다 합쳐 재면 그 래퍼가 전부 헛짚음으로 잡힌다 — 재는 자가 틀린 것이지 갈래가
            #: 틀린 것이 아니다. 사람이 짚어 준 여섯 줄과 가장 잘 맞는 레인 하나를 찾는다.
            best = None
            for lane in {one for one in who if one}:
                mine = {index for index, one in enumerate(who) if one == lane}
                score = len(mine & want) - len(mine - want) * 0.5
                if best is None or score > best[0]:
                    best = (score, lane, mine)
            if best is None:
                print(f"        {way:<6} 안 갈림")
                continue
            _, lane, mine = best
            print(f"        {way:<6} 레인 {lane} = {sorted(mine)[:12]}"
                  f"  → 정답 {len(mine & want)}/{len(want)} · 헛짚음 {len(mine - want)}")
