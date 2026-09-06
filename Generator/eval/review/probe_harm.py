#!/usr/bin/env python3
"""**가사 아닌 소리가 낀 자리의 줄이 실제로 더 나쁜가.** 막기 전에 그것부터 잰다.

`probe_alien` 이 찾아낸 것: 열세 곡 가운데 여덟에 「받아 적혔는데 가사장의 어느 것과도 안
짝지어진 구간」이 있다. 하치와레girl 은 진짜 일본어 대사고, 야해·미안하다는말·파란달팽이·Daddy 는
whisper 환각이며(`한글자막 by 한효정`), 붉은 노을은 가사에 없는 애드리브다.

막고 싶어지지만 두 가지가 걸린다. 하나, **Daddy 는 앞 29 초가 통째로 환각인데 제자리가 96% 다** —
닻이 이미 그 구간을 건너뛰므로 해를 안 끼치고 있을 수 있다. 둘, **고스트시티의 그 구간은 부르고
있는 진짜 가사**인데 받아쓰기가 뭉갠 것뿐이다. 막으면 그 줄을 막는다.

그래서 줄을 둘로 갈라 견준다: 그 구간에 걸친 줄과 그렇지 않은 줄. 걸친 줄이 뚜렷이 나쁘면 막을
값어치가 있고, 다르지 않으면 막는 것은 위험만 늘리는 일이다.

@example
  python probe_harm.py 11 12 9
"""
import json
import os
import re
import sys
from pathlib import Path
import sqlite3

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402
from probe_alien import RUN_LEAST, alien_runs  # noqa: E402

NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")
#: 그 구간이 이보다 길어야 셈에 넣는다(ms).
LONG_MS = 3000
#: 가운뎃값에서 이 안이면 제자리로 친다(ms).
NEAR_MS = 500


def words_of(text: str) -> list[str]:
    """Split a line into the words the aligner uses, dropping marks that carry no sound.

    @param {str} text - One lyric line.
    @returns {list[str]} Words worth aligning.
    """
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def main() -> int:
    """Score the lines that sit in unaccounted-for stretches against the rest.

    @returns {int} 0 always.
    """
    want = {int(one) for one in sys.argv[1:]}
    conn = sqlite3.connect(HERE / os.environ.get("MORA_DB", "review.db"))
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM songs ORDER BY id").fetchall()
    print(f"  {'곡':<20} {'걸친 줄':>18}   {'나머지 줄':>18}")
    both: dict[str, list[int]] = {"걸침": [], "나머지": []}

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
        runs = [one for one in alien_runs(sheet, said) if one[1] - one[0] >= LONG_MS]
        if not runs:
            continue

        blind = [{**one, "at": None} for one in lines]
        out, _ = align.align_voices(found, blind, words_of, row["title"])
        marks: list[tuple[int, int, bool]] = []
        for at, line in enumerate(lines):
            real = line.get("at")
            chars = [one for word in out[at] for one in (word.get("chars") or [])
                     if one.get("at") is not None] if at < len(out) else []
            if real is None or not chars:
                continue
            #: 그 줄이 울리는 동안. 다음 줄이 시작하기 전까지로 본다.
            until = next((lines[two]["at"] for two in range(at + 1, len(lines))
                          if lines[two].get("at") is not None), real + 3000)
            touched = any(min(until, b) - max(real, a) > 0 for a, b, _ in runs)
            marks.append((chars[0]["at"] - real, at, touched))

        if not marks:
            continue
        mid = sorted(one[0] for one in marks)[len(marks) // 2]
        say = []
        for name, flag in (("걸침", True), ("나머지", False)):
            mine = [one[0] for one in marks if one[2] is flag]
            both[name].extend(mine)
            if mine:
                near = sum(1 for one in mine if abs(one - mid) <= NEAR_MS)
                say.append(f"{len(mine):>3}줄 제자리 {near / len(mine) * 100:>3.0f}%")
            else:
                say.append("        없음")
        print(f"  [{row['id']:>2}] {row['title'][:14]:<15} " + "   ".join(f"{one:>18}" for one in say),
              flush=True)

    print()
    for name, mine in both.items():
        if not mine:
            continue
        mid = sorted(mine)[len(mine) // 2]
        near = sum(1 for one in mine if abs(one - mid) <= NEAR_MS)
        gaps = sorted(abs(one) for one in mine)
        print(f"  {name:<6} {len(mine):>4}줄 · 제자리 {near / len(mine) * 100:>3.0f}% · "
              f"어긋남 가운뎃값 {gaps[len(gaps) // 2] / 1000:.2f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
