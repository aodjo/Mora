"""**가사가 줄여 적은 반복을 받아쓰기로 되살린다.**

멜론·벅스·지니·플로는 이어서 되풀이되는 후렴을 한 번만 적는다. 아크라포빅의 「난 너랑 결혼했을걸」은
세 번 불리는데 가사에는 한 줄이라, 맞춘 결과에서 나머지 두 번과 끝 후렴 묶음 전체가 비었다. 바이브는
풀어 적는다 — 그러니 바이브의 줄을 정답으로 두고 줄인 가사에서 되살리는 만큼을 잴 수 있다.

받아쓰기의 음절 줄에 가사의 음절 줄을 맞추되, 한 줄을 다 부른 자리에서 방금 부른 한~네 줄 묶음의
처음으로 되돌아갈 수 있게 한다. 되돌아가는 데는 값이 들고, 그 값은 되풀이된 소리가 받아쓰기에
실제로 적혀 있을 때만 치를 만하다 — 적혀 있지 않으면 되돌아간 줄을 전부 「못 들음」으로 치르느니
안 되돌아가는 편이 싸다. 받아쓰기가 빠뜨린 반복은 못 살리지만, 없는 반복을 지어내지도 않는다.

    from repeat_fill import expand
    order = expand(["A", "B"], heard)   # [0, 0, 0, 1] — A 를 세 번 부르고 B
"""
from __future__ import annotations

import os
import re

#: 받아쓰기에만 있는 음절 하나(애드리브·잡음·지어낸 말)의 값.
EXTRA = float(os.environ.get("MORA_REPEAT_EXTRA", "0.6"))
#: 가사에만 있는 음절 하나(받아쓰기가 흘린 말)의 값. whisper 는 흘리는 쪽이 잦아 조금 무겁게.
MISSED = float(os.environ.get("MORA_REPEAT_MISSED", "0.8"))
#: 되돌아가 한 묶음을 다시 부르는 값.
REPEAT = float(os.environ.get("MORA_REPEAT_COST", "2.5"))
#: 되돌아갈 수 있는 묶음의 줄 수.
BLOCK = int(os.environ.get("MORA_REPEAT_BLOCK", "4"))
#: 곡 앞뒤의 받아쓰기(인사·말소리)는 싸게 버린다.
EDGE = 0.3
#: 받아쓰기의 시각이 이만큼(ms) 넘게 거꾸로 가면 같은 소리를 두 번 적은 것이다. 보고싶다 친구야는
#: 「작은 책상 앞에 … 철이야 안녕」을 29.8 초까지 적고 20.4 초로 돌아가 한 번 더 적었다 — 듣기를
#: 여러 번 해 합친 자리의 겹침이다. 그대로 두면 부르지 않은 반복이 들린 것처럼 보여, 줄이지 않은
#: 가사 서른한 곡에 없는 반복 마흔세 줄을 끼워 넣었다.
BACKWARD_MS = 300


def syllables(text: str) -> list[str]:
    """Break text into the units both sides are compared in: Hangul syllables, Latin letters, digits.

    @param {str} text - A lyric line or a transcribed word.
    @returns {list[str]} Lower-cased units, punctuation and spaces dropped.
    """
    return [one.lower() for one in re.findall(r"[가-힣]|[A-Za-z]|[0-9]", text)]


def unlike(a: str, b: str) -> float:
    """How different two units are: 0 the same, 0.5 a Hangul syllable with the same onset and vowel, else 1.

    @param {str} a - One unit.
    @param {str} b - Another unit.
    @returns {float} The substitution cost.
    """
    if a == b:
        return 0.0
    if "가" <= a <= "힣" and "가" <= b <= "힣" and (ord(a) - 0xAC00) // 28 == (ord(b) - 0xAC00) // 28:
        return 0.5
    return 1.0


def expand(lines: list[str], heard: list[tuple[str, int]]) -> list[int]:
    """The order the lines were sung in, with immediate repeats the text left out put back.

    A dynamic program over (transcript unit, lyric unit). Each column takes the transcript one unit
    further: match or substitute, a unit only the transcript has, then units only the lyric has,
    then the jumps from the end of a line back to the head of a block of up to `BLOCK` lines ending
    there, then units only the lyric has once more. A jump only ever improves a strictly cheaper
    state, and going round a block costs at least `REPEAT`, so the back-pointers never loop.

    @param {list[str]} lines - The lyric lines as written.
    @param {list[tuple[str, int]]} heard - The transcript: each word and the ms it starts at.
    @returns {list[int]} Line indices in sung order. Without any repeat this is `range(len(lines))`.
    """
    sheet: list[str] = []
    starts: list[int] = []
    ends: list[int] = []
    for line in lines:
        starts.append(len(sheet))
        sheet.extend(syllables(line))
        ends.append(len(sheet))
    forward: list[str] = []
    latest = None
    for word, at in heard:
        if latest is not None and at < latest - BACKWARD_MS:
            continue
        forward.append(word)
        latest = at if latest is None else max(latest, at)
    said = [unit for word in forward for unit in syllables(word)]
    size, count = len(sheet), len(said)
    if not size or not count:
        return list(range(len(lines)))
    back: list[tuple[int, int, int]] = []
    for last in range(len(lines)):
        if ends[last] == starts[last]:
            continue
        spoken = [k for k in range(last, -1, -1) if ends[k] > starts[k]][:BLOCK]
        back.extend((ends[last], starts[first], last) for first in spoken)
    INF = float("inf")
    prev = [p * MISSED for p in range(size + 1)]
    steps: list[bytearray] = [bytearray([2] * (size + 1))]
    jumps: list[dict[int, tuple[int, int]]] = [{}]
    finish = [prev[size]]
    for t in range(1, count + 1):
        unit = said[t - 1]
        cur = [INF] * (size + 1)
        step = bytearray(size + 1)
        jump: dict[int, tuple[int, int]] = {}
        cur[0], step[0] = prev[0] + EDGE, 1
        for p in range(1, size + 1):
            match = prev[p - 1] + unlike(unit, sheet[p - 1])
            extra = prev[p] + EXTRA
            if match <= extra:
                cur[p], step[p] = match, 0
            else:
                cur[p], step[p] = extra, 1
        for p in range(1, size + 1):
            if cur[p - 1] + MISSED < cur[p]:
                cur[p], step[p] = cur[p - 1] + MISSED, 2
        moved = False
        for end, head, last in back:
            if cur[end] + REPEAT < cur[head]:
                cur[head], step[head] = cur[end] + REPEAT, 3
                jump[head] = (end, last)
                moved = True
        if moved:
            for p in range(1, size + 1):
                if cur[p - 1] + MISSED < cur[p]:
                    cur[p], step[p] = cur[p - 1] + MISSED, 2
        prev = cur
        steps.append(step)
        jumps.append(jump)
        finish.append(cur[size])

    t = min(range(count + 1), key=lambda k: finish[k] + (count - k) * EDGE)
    p = size
    repeats: list[tuple[int, int]] = []
    while t > 0 or p > 0:
        if t == 0:
            p -= 1
            continue
        kind = steps[t][p]
        if kind == 0:
            t, p = t - 1, p - 1
        elif kind == 1:
            t -= 1
        elif kind == 2:
            p -= 1
        else:
            end, last = jumps[t][p]
            first = next(k for k in range(len(lines)) if starts[k] == p and ends[k] > starts[k])
            repeats.append((last, first))
            p = end
    repeats.reverse()
    order: list[int] = []
    cursor = 0
    for last, first in repeats:
        order.extend(range(cursor, last + 1))
        cursor = first
    order.extend(range(cursor, len(lines)))
    return order
