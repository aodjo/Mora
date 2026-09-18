"""**가사가 줄여 적은 반복을 받아쓰기로 되살린다.**

멜론·벅스·지니·플로는 이어서 되풀이되는 후렴을 한 번만 적는다. 아크라포빅의 「난 너랑 결혼했을걸」은
세 번 불리는데 가사에는 한 줄이라, 맞춘 결과에서 나머지 두 번과 끝 후렴 묶음 전체가 비었다. 바이브는
풀어 적는다 — 그러니 바이브의 줄을 정답으로 두고 줄인 가사에서 되살리는 만큼을 잴 수 있다.

받아쓰기의 음절 줄에 가사의 음절 줄을 맞추되, 한 줄을 다 부른 자리에서 방금 부른 한~네 줄 묶음의
처음으로 되돌아갈 수 있게 한다. 되돌아가는 데는 값이 들고, 그 값은 되풀이된 소리가 받아쓰기에
실제로 적혀 있을 때만 치를 만하다 — 적혀 있지 않으면 되돌아간 줄을 전부 「못 들음」으로 치르느니
안 되돌아가는 편이 싸다. 받아쓰기가 빠뜨린 반복은 못 살리지만, 없는 반복을 지어내지도 않는다.

소리 모델로 가리는 길은 재 보고 껐다(`listen` 을 주면 켜진다). 서른한 곡에서 받아쓰기만 쓰면 되살림
63/121 · 지어냄 8 인데, CTC 로 「이 창에서 이 가사가 들리나」를 물어 가리면 57/121 · 25 로 나빠진다.
까닭은 그 물음의 판별력이다 — 제 글은 가운데 0.87, **같은 곡의 엉뚱한 줄도 0.40** 이고 문턱 0.6 에서
엉뚱한 줄 17%가 지난다. 목소리 없는 창 거르기, 창 넓히기, 글자를 뒤집은 대조 글과 견주기를 차례로
넣어 43 → 25 까지 줄였지만 받아쓰기만 못했다. 프레임별 발음 확률로 두 구간의 닮은꼴을 재는 길도
갈리지 않았다(같은 글 0.96 · 다른 글 0.94, 빈칸을 빼도 같음). 랩 후렴처럼 받아쓰기가 뭉갠 반복은
그래서 아직 못 살린다.

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
#: 되돌아가 한 묶음을 다시 부르는 값. 서른한 곡에서 0.8~2.0 은 되살림 63 으로 같고 2.5 는 58 로 떨어진다.
#: 지어냄은 0.8~1.2 에서 9, 1.6~2.5 에서 8 이다. 1.2 를 쓰는 까닭은 한 줄 차이보다 아크라포빅 꼴이다 —
#: 「난 너랑 결혼했을걸」 ×3 + 「…거야」는 끝 음절만 다르므로, 되돌아가는 값이 1.3 을 넘으면 두 줄을
#: 번갈아 부른 것으로 읽는 편이 싸진다. 세 번 부른 줄은 세 번으로 되살아나야 한다.
REPEAT = float(os.environ.get("MORA_REPEAT_COST", "1.2"))
#: 되돌아갈 수 있는 묶음의 줄 수.
BLOCK = int(os.environ.get("MORA_REPEAT_BLOCK", "4"))
#: 곡 앞뒤의 받아쓰기(인사·말소리)는 싸게 버린다. 끝 후렴의 되풀이도 그 꼬리에 함께 버려지지만,
#: 그것을 값으로 되살리려 하면(꼬리를 EXTRA 로 무겁게) 서른한 곡에서 지어낸 줄이 8 → 20 으로 늘고
#: 되살림은 63 → 61 로 줄었다. 끝 반복은 값이 아니라 소리로 판단한다(`fill_quiet` 의 꼬리).
EDGE = 0.3
#: 받아쓰기의 시각이 이만큼(ms) 넘게 거꾸로 가면 같은 소리를 두 번 적은 것이다. 보고싶다 친구야는
#: 「작은 책상 앞에 … 철이야 안녕」을 29.8 초까지 적고 20.4 초로 돌아가 한 번 더 적었다 — 듣기를
#: 여러 번 해 합친 자리의 겹침이다. 그대로 두면 부르지 않은 반복이 들린 것처럼 보여, 줄이지 않은
#: 가사 서른한 곡에 없는 반복 마흔세 줄을 끼워 넣었다.
BACKWARD_MS = 300


#: 소리 모델이 이만큼(0~1)은 들어야 그 자리에서 불렸다고 본다. 열한 곡 614 줄에서 제 글은 가운데 0.87,
#: 같은 곡의 다른 줄은 0.40 이었다 — 0.6 이면 제 글 78%가 지나고 다른 줄은 17%만 지난다.
SHARE = float(os.environ.get("MORA_REPEAT_SHARE", "0.6"))
#: 그 값만으로는 모자란다. 노래는 곡마다 모델이 듣는 정도가 달라(붉은 노을은 제 글도 가운데 0.57)
#: 같은 묶음이 **원래 불린 자리**에서 받은 값과도 견준다.
RELATIVE = float(os.environ.get("MORA_REPEAT_RELATIVE", "0.8"))
#: 받아쓰기가 아무것도 적지 않은 자리가 이보다 길면 무엇이 불렸는지 소리로 물어본다(ms).
QUIET_MS = int(os.environ.get("MORA_REPEAT_QUIET_MS", "2500"))
#: 한 묶음을 이어서 이만큼까지 되풀이해 본다.
MOST = int(os.environ.get("MORA_REPEAT_MOST", "6"))
#: 들은 자리 앞뒤로 창을 이만큼 넓혀 묻는다(ms) — 받아쓰기 시각은 낱말 머리라 끝이 짧다.
LEAD_MS, TAIL_MS = 250, 600
#: 한 묶음을 다시 부르기까지의 숨(ms). 묶음 길이를 잴 때 더한다.
PAUSE_MS = 300
#: CTC 는 노랫소리 위에 어떤 글이든 밀어 넣는다 — 같은 곡의 엉뚱한 줄도 가운데 0.40 을 받았다. 그래서
#: 후보와 **글자를 거꾸로 돌린 대조 글**을 같은 창에서 재고, 후보가 이만큼은 앞서야 그 가사로 본다.
MARGIN = float(os.environ.get("MORA_REPEAT_MARGIN", "0.15"))


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


def expand(lines: list[str], heard: list[tuple[str, int]], listen=None, until: int | None = None) -> list[int]:
    """The order the lines were sung in, with immediate repeats the text left out put back.

    With `listen` — a function from `align.repeat_ears` saying what share of a text the acoustic
    model hears in a window — two more things happen. A repeat the transcript claims is dropped
    when the model does not hear it, and a **quiet stretch the transcript wrote nothing in** is
    offered the block of lines before it, once or several times over, and kept when the model does
    hear it. That is the only way to reach a hook the transcript cannot write down.

    @param {list[str]} lines - The lyric lines as written.
    @param {list[tuple[str, int]]} heard - The transcript: each word and the ms it starts at.
    @param {callable | None} [listen=None] - `listen(text, since_ms, until_ms) -> share 0..1`.
    @param {int | None} [until=None] - Where the singing ends (ms), so the last hole can be asked about too.
    @returns {list[int]} Line indices in sung order.
    """
    order, times = walk(lines, heard)
    if listen is None:
        return order
    order, times = only_heard(lines, order, times, listen)
    return fill_quiet(lines, order, times, listen, until)


def walk(lines: list[str], heard: list[tuple[str, int]]) -> tuple[list[int], list[tuple[int, int] | None]]:
    """The sung order from the transcript alone, and when each line's words were heard.

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
    forward: list[tuple[str, int]] = []
    latest = None
    for word, at in heard:
        if latest is not None and at < latest - BACKWARD_MS:
            continue
        forward.append((word, at))
        latest = at if latest is None else max(latest, at)
    said: list[str] = []
    when: list[int] = []
    for word, at in forward:
        for unit in syllables(word):
            said.append(unit)
            when.append(at)
    mine = [index for index, line in enumerate(lines) for _ in syllables(line)]
    size, count = len(sheet), len(said)
    if not size or not count:
        return list(range(len(lines))), [None] * len(lines)
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
    trail: list[tuple[str, int, int]] = []
    while t > 0 or p > 0:
        if t == 0:
            p -= 1
            continue
        kind = steps[t][p]
        if kind == 0:
            trail.append(("들림", mine[p - 1], when[t - 1]))
            t, p = t - 1, p - 1
        elif kind == 1:
            t -= 1
        elif kind == 2:
            p -= 1
        else:
            end, last = jumps[t][p]
            first = next(k for k in range(len(lines)) if starts[k] == p and ends[k] > starts[k])
            trail.append(("되돌아감", last, first))
            p = end
    trail.reverse()
    order: list[int] = []
    times: list[tuple[int, int] | None] = []
    cursor = 0
    marks: dict[int, list[int]] = {}

    def close(last: int) -> None:
        """Write out the lines of the block that just ended, with the times heard inside it."""
        for line in range(cursor, last + 1):
            order.append(line)
            got = marks.get(line)
            times.append((min(got), max(got)) if got else None)
        marks.clear()

    for kind, a, b in trail:
        if kind == "들림":
            marks.setdefault(a, []).append(b)
        else:
            close(a)
            cursor = b
    close(len(lines) - 1)
    return order, times


def only_heard(lines: list[str], order: list[int], times: list[tuple[int, int] | None],
               listen) -> tuple[list[int], list[tuple[int, int] | None]]:
    """Drop the repeats the transcript claims but the acoustic model does not hear.

    The transcript is written by a model that sometimes says a line twice where it was sung once.
    A repeat is kept only when the model also hears it in the window the transcript puts it in.

    @param {list[str]} lines - The lyric lines as written.
    @param {list[int]} order - Line indices in sung order.
    @param {list[tuple[int, int] | None]} times - When each place's words were heard.
    @param {callable} listen - `listen(text, since_ms, until_ms) -> share 0..1`.
    @returns {tuple[list[int], list[tuple[int, int] | None]]} The order and times that survive.
    """
    seen: set[int] = set()
    kept_order: list[int] = []
    kept_times: list[tuple[int, int] | None] = []
    for place, (line, at) in enumerate(zip(order, times)):
        again = line in seen
        seen.add(line)
        if again and at is not None and lines[line].strip():
            #: 받아쓰기 시각은 낱말 **머리**라 줄의 끝이 창 밖에 남는다. 다음 줄이 들린 자리까지 열어
            #: 준다 — 좁게 물으면 진짜 반복도 떨어진다(좁은 창에서 되살림 63 → 49).
            later = next((one[0] for one in times[place + 1:] if one is not None), None)
            until = at[1] + TAIL_MS if later is None else max(at[1] + TAIL_MS, min(later, at[1] + 4000))
            if listen(lines[line], at[0] - LEAD_MS, until) < SHARE:
                continue
        kept_order.append(line)
        kept_times.append(at)
    return kept_order, kept_times


def fill_quiet(lines: list[str], order: list[int], times: list[tuple[int, int] | None], listen,
               until: int | None = None) -> list[int]:
    """Offer the block before a silent stretch to the acoustic model, and put it back when heard.

    Where the transcript wrote nothing for seconds on end — a fast hook, a heavily processed
    chorus — there is no evidence to jump on, so the sung repeats are lost. The block of lines just
    before the hole is the thing most likely to fill it, so it is aligned there once, twice, as
    many times as the hole is long, and the reading the model hears best is taken.

    @param {list[str]} lines - The lyric lines as written.
    @param {list[int]} order - Line indices in sung order.
    @param {list[tuple[int, int] | None]} times - When each place's words were heard.
    @param {callable} listen - `listen(text, since_ms, until_ms) -> share 0..1`.
    @param {int | None} [until=None] - Where the singing ends (ms). The hole after the last line is
        where a shortened last chorus hides, and the transcript's own tail is thrown away cheaply,
        so nothing but the model can say what is in there.
    @returns {list[int]} The order with the heard blocks put back.
    """
    spots = [index for index, at in enumerate(times) if at is not None]
    holes = list(zip(spots, spots[1:]))
    if until is not None and spots:
        holes.append((spots[-1], None))
    added: dict[int, list[int]] = {}
    for one, two in holes:
        here = times[one]
        next_one = times[two] if two is not None else (until, until)
        gap = next_one[0] - here[1]
        if gap < QUIET_MS:
            continue
        best: tuple[float, int, list[int]] = (0.0, 0, [])
        for size in range(1, BLOCK + 1):
            first = one - size + 1
            if first < 0 or times[first] is None or any(not lines[order[k]].strip() for k in range(first, one + 1)):
                continue
            block = [order[k] for k in range(first, one + 1)]
            span = max(500, here[1] - times[first][0] + PAUSE_MS)
            text = " ".join(lines[line] for line in block)
            floor = max(SHARE, RELATIVE * listen(text, times[first][0] - LEAD_MS, here[1] + TAIL_MS))
            for many in range(min(MOST, int(gap / span)), 0, -1):
                said = " ".join(lines[line] for line in block * many)
                share = listen(said, here[1] + 100, next_one[0])
                if share < max(best[0], floor) or many * len(block) <= len(best[2]):
                    continue
                #: 같은 창, 같은 글자, 뒤집힌 차례. 이보다 앞서지 못하면 그 자리에서 들리는 것은
                #: 이 가사가 아니라 그냥 노랫소리다.
                control = " ".join(word[::-1] for word in said.split())
                if share - listen(control, here[1] + 100, next_one[0]) >= MARGIN:
                    best = (share, many, block * many)
        if best[2]:
            added[one] = best[2]
    if not added:
        return order
    grown: list[int] = []
    for index, line in enumerate(order):
        grown.append(line)
        grown.extend(added.get(index, []))
    return grown
