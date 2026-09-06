#!/usr/bin/env python3
"""**소리는 나는데 가사가 아닌 구간이 어디에 얼마나 있나.**

앞머리 중얼거림은 고쳤다. 그런데 곡 **중간**에 가사에 없는 말이 끼면 아직 못 막는다. 막는 장치가
둘 있는데 둘 다 안 듣기 때문이다 — 앞머리 막기는 첫 줄 앞만 보고, 쉼 막기는 화자분리가 조용하다고
한 곳만 본다. 사람이 말하고 있으면 쉼이 아니다.

그런데 받아쓰기는 그것을 적는다. 그리고 그 글자는 가사장의 어느 것과도 안 짝지어진다. 그러니
**낱말은 있는데 짝이 없는 구간**을 찾으면 그것이 곧 「소리는 나는데 가사가 아닌 곳」이다.

여기서는 막기 전에 재기만 한다. 그런 구간이 실제로 얼마나 되는지, 곡의 어디인지, 그리고 그것이
진짜 가사가 아닌지를 눈으로 봐야 한다 — 잘못 막으면 부르고 있는 줄을 막는다.

@example
  python probe_alien.py 11
  python probe_alien.py            # 열세 곡 셈만
"""
import difflib
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402

NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")
#: 짝 없는 낱말이 이만큼 이어져야 한 구간으로 본다.
RUN_LEAST = 4
#: 그 구간이 이보다 길어야 말할 값어치가 있다(ms).
LONG_MS = 3000


def words_of(text: str) -> list[str]:
    """Split a line into the words the aligner uses, dropping marks that carry no sound.

    @param {str} text - One lyric line.
    @returns {list[str]} Words worth aligning.
    """
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def alien_runs(sheet: list[tuple[str, int]], said: list[tuple[str, int]]) -> list[tuple[int, int, str]]:
    """Stretches of transcript that nothing in the sheet accounts for.

    @param {list[tuple[str, int]]} sheet - Lyric grains paired with their line.
    @param {list[tuple[str, int]]} said - Heard words paired with their time.
    @returns {list[tuple[int, int, str]]} Start ms, end ms, and what was heard there.
    """
    mine, _ = align.jamo_of(sheet)
    yours, from_yours = align.jamo_of(said)
    matched: set[int] = set()
    for a, b, size in difflib.SequenceMatcher(None, mine, yours, autojunk=False).get_matching_blocks():
        if size < align.HEARD_SOLID:
            continue
        for step in range(size):
            matched.add(from_yours[b + step])

    out: list[tuple[int, int, str]] = []
    run: list[int] = []
    for at in range(len(said)):
        if at in matched:
            if len(run) >= RUN_LEAST:
                out.append((said[run[0]][1], said[run[-1]][1], " ".join(said[one][0] for one in run)))
            run = []
        else:
            run.append(at)
    if len(run) >= RUN_LEAST:
        out.append((said[run[0]][1], said[run[-1]][1], " ".join(said[one][0] for one in run)))
    return out


def main() -> int:
    """Print, per song, the stretches heard but not accounted for by the sheet.

    @returns {int} 0 always.
    """
    want = {int(one) for one in sys.argv[1:]}
    conn = sqlite3.connect(HERE / os.environ.get("MORA_DB", "review.db"))
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM songs ORDER BY id").fetchall()
    print(f"  {'곡':<22} {'곡 길이':>7} {'남의 말':>7} {'그 몫':>6}  가장 긴 구간")
    for row in rows:
        if want and row["id"] not in want:
            continue
        found = align.source_in(HERE / "audio", row["video_id"])
        if not found:
            continue
        lines = json.loads(row["lines"])
        sheet: list[tuple[str, int]] = []
        for at, line in enumerate(lines):
            for word in words_of(line.get("text", "")):
                for grain in align.grains_of(align.speakable(word)):
                    sheet.append((grain, at))
        said, _ = align.best_heard(found, align.jamo_of(sheet)[0], lines, words_of)
        if not said:
            continue
        runs = [one for one in alien_runs(sheet, said) if one[1] - one[0] >= LONG_MS]
        held = sum(b - a for a, b, _ in runs)
        span = (row["duration"] or 0) * 1000
        big = max(runs, key=lambda one: one[1] - one[0]) if runs else None
        say = f"{big[0] / 1000:6.1f}s ~{big[1] / 1000:6.1f}s  {big[2][:34]}" if big else ""
        print(f"  [{row['id']:>2}] {row['title'][:15]:<16} {span / 1000:6.0f}s {held / 1000:6.1f}s "
              f"{held / span * 100 if span else 0:5.0f}%  {say}", flush=True)
        if want:
            for a, b, what in runs:
                print(f"        {a / 1000:7.1f}s ~{b / 1000:7.1f}s  ({(b - a) / 1000:.1f}s)  {what[:60]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
