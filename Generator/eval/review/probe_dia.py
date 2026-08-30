#!/usr/bin/env python3
"""**Sortformer 가 낸 사람 구분을 우리 줄에 붙여 보고, 지금 쓰는 자국과 견준다.**

지금은 줄마다 ECAPA 자국을 하나 떠서 무리 짓는다. 그 틀에는 두 가지 한계가 있다 —
말로 배운 자국이라 노래에서 흔들려 **솔로 다섯 곡 중 셋이 갈렸고**, 줄마다 사람이 하나라서
**둘이 동시에 부르는 대목을 아예 표현할 수 없다.**

Sortformer 는 사람마다 프레임마다 「지금 부르나」를 내므로 둘 다 다르다. 여기서 재는 것:

  1. 솔로 곡이 한 명으로 나오는가 (지금은 다섯 중 셋이 갈린다)
  2. Small girl 18·19·20·60·61·62 번이 다른 사람으로 잡히는가 (사람이 귀로 짚어 준 줄)
  3. 겹치는 대목이 실제로 어디인가

@example
  python probe_dia.py 7 9
"""
import json
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402

NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")
SOLO = {1, 2, 4, 5, 6}
MANY = {3, 7, 8, 9}
#: 사람이 귀로 짚어 준, 서브가 부르는 Small girl 의 줄.
TRUTH = {7: {18, 19, 20, 60, 61, 62}}
#: 딴 살림. `nemo_toolkit` 이 torch 2.8 이상을 달라는데 정렬기는 2.7 에 묶여 있다.
DIA = Path.home() / "dia/bin/python"


def words_of(text: str) -> list[str]:
    """Split a line into the words the aligner uses, dropping marks that carry no sound.

    @param {str} text - One lyric line.
    @returns {list[str]} Words worth aligning.
    """
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def diarized(stem: Path) -> dict:
    """Run the diarizer on one stem, reusing an earlier answer when there is one.

    @param {Path} stem - The audio to read.
    @returns {dict} The diarizer's JSON, or an empty dict when it failed.
    @throws {RuntimeError} When the separate environment is missing.
    """
    into = stem.with_suffix(".dia.json")
    if into.exists():
        return json.loads(into.read_text(encoding="utf-8"))
    if not DIA.exists():
        raise RuntimeError(f"딴 살림이 없다: {DIA}")
    subprocess.run([str(DIA), str(HERE / "diarize.py"), str(stem), str(into)],
                   check=False, capture_output=True)
    return json.loads(into.read_text(encoding="utf-8")) if into.exists() else {}


def who_of(said: dict, since: float, until: float) -> tuple[int | None, int]:
    """Say who sings a stretch, and how many people sing in it at once.

    @param {dict} said - The diarizer's answer.
    @param {float} since - Start of the stretch, in seconds.
    @param {float} until - End of the stretch, in seconds.
    @returns {tuple[int | None, int]} The person holding the most of it, and how many were heard.
    """
    held: dict[int, float] = {}
    for one in said.get("쪽", []):
        for a, b in one["토막"]:
            over = min(until, b) - max(since, a)
            if over > 0:
                held[one["누구"]] = held.get(one["누구"], 0.0) + over
    if not held:
        return None, 0
    #: 「부른다」로 치려면 그 줄의 1/5 은 차지해야 한다. 스치는 숨소리까지 세면 모든 줄이 겹친다.
    room = max(0.001, until - since)
    many = sum(1 for one in held.values() if one / room >= 0.2)
    return max(held, key=lambda one: held[one]), many


conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
want = [int(one) for one in sys.argv[1:]] or sorted(SOLO | MANY)

for song in want:
    row = conn.execute("SELECT * FROM songs WHERE id=?", (song,)).fetchone()
    found = align.source_in(HERE / "audio", row["video_id"])
    if not found:
        continue
    stem = align.vocals_of(found)
    said = diarized(stem)
    if not said:
        print(f"  [{song}] 안 돎")
        continue

    lines = json.loads(row["lines"])
    out, lanes = align.align_voices(found, lines, words_of, row["title"])

    mine: dict[int, int] = {}
    both: list[int] = []
    for index, words in enumerate(out):
        chars = [one for word in words for one in (word.get("chars") or [])]
        if not chars:
            continue
        who, many = who_of(said, chars[0]["at"] / 1000, chars[-1]["end"] / 1000)
        if who is not None:
            mine[index] = who
        if many > 1:
            both.append(index)

    tally: dict[int, int] = {}
    for one in mine.values():
        tally[one] = tally.get(one, 0) + 1
    was: dict[int, int] = {}
    for one in lanes.values():
        was[one] = was.get(one, 0) + 1

    mark = "여럿" if song in MANY else ("혼자" if song in SOLO else "?")
    print(f"\n  [{song}] {row['artist'][:10]} — {row['title'][:20]}  {mark}")
    print(f"      지금(ECAPA)  {dict(sorted(was.items()))}")
    print(f"      Sortformer   {dict(sorted(tally.items()))} · 겹친 줄 {len(both)}개 "
          f"· 겹친 시간 {said.get('겹친 시간', 0)}s")
    if song in TRUTH:
        for lane in sorted(tally):
            got = {index for index, one in mine.items() if one == lane}
            print(f"        {lane}번 사람 = {len(got)}줄 · 정답 {len(got & TRUTH[song])}/6 "
                  f"· 헛짚음 {len(got - TRUTH[song])}")
    if both:
        print(f"        겹친 줄 {both[:10]}")
