#!/usr/bin/env python3
"""**들은 것을 닻으로 쓰면 줄자리를 더 잘 짚나.** 지금의 짐작과 같은 자로 견준다.

강제정렬은 준 가사를 소리 전체에 **반드시 다 펼쳐야** 한다. 「여기는 아무도 안 부른다」고 말할
길이 없어서 간주로 흘러들고, 그래서 긴 곡에서 중간부터 밀린다. 지금 그 빈자리는
`align.guess_clock` 이 메우는데, 그것은 화자분리가 「부른다」고 한 구간에 음절 수 비례로 줄을
고르게 뿌리는 짐작이다 — 누가 부르는지는 알아도 **무엇을** 부르는지는 모른다.

받아쓰기에는 강제정렬에 없는 것이 하나 있다: 아무 말도 안 나오는 자리를 비워 둘 수 있다.
kresnik CTC 를 자유롭게 풀면 (한글 음절, 빈칸 포함) 「몇 초에 무슨 소리가 났다」가 나온다. 그
받아쓰기는 엉망이지만 — `조이스쉬 마기 시내 화치화` 가 실은 `조용히 숨을 셔 … 맞춰` 다 —
닻으로 쓰는 데는 정확한 글자가 필요 없고 **소리가 닮았다**는 것만 있으면 된다.

그래서 여기서 재는 것: 들은 음절을 낱자(자모)로 풀어 진짜 가사와 짝지어 줄마다 시각을 뽑고,
그것과 `guess_clock` 의 짐작을 **바깥에서 온 진짜 시각**과 각각 견준다. 닻이 더 가까우면
받아쓰기를 붙일 값어치가 있는 것이고, 아니면 없는 것이다.

@example
  python probe_hear.py            # 열두 곡
  python probe_hear.py 8 11       # 이 두 곡만
"""
import difflib
import json
import os
import re
import sys
import unicodedata
import urllib.request
from pathlib import Path

#: 자유롭게 풀려면 한글 음절을 그대로 뱉는 모델이라야 한다. MMS_FA 는 로마자 스물아홉 자뿐이라
#: 받아쓰기로는 못 읽는다. `align` 을 들이기 **전에** 세워야 켜진다.
os.environ["MORA_ACOUSTIC"] = "kresnik"

import torch  # noqa: E402

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402

#: 어디서 읽나.
BASE = "http://127.0.0.1:8787"
#: 이 안에 들어오면 그 줄을 제자리에 놓은 것으로 친다(ms).
NEAR = (500, 1000, 2000)
#: 짝이 이만큼(자모) 길어야 믿는다. 두어 자 우연히 겹치는 것으로 닻을 삼으면 되풀이되는 가사가
#: 엉뚱한 되풀이 자리에 붙어 곡이 통째로 밀린다.
SOLID = int(os.environ.get("MORA_SOLID", "8"))
#: 소리 없는 표시. 정렬기가 버리는 것과 같은 것을 버려야 낱자 셈이 어긋나지 않는다.
NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")


def words_of(text: str) -> list[str]:
    """Split a line into the words the aligner uses, dropping marks that carry no sound.

    @param {str} text - One lyric line.
    @returns {list[str]} Words worth aligning.
    """
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def heard(path: Path) -> list[tuple[str, int]]:
    """Freely decode the lead stem, returning each syllable it hears and when.

    Greedy CTC: the most likely token per frame, with repeats collapsed and blanks dropped. Blanks
    are what matter here — they are the model saying nothing is being sung, which is exactly the
    thing forced alignment cannot say.

    @param {Path} path - The lead vocal stem.
    @returns {list[tuple[str, int]]} Each heard syllable and the ms at which it starts.
    """
    audio = align.read_audio(path, align.SAMPLE_RATE, 1)[0].unsqueeze(0)
    log_probs = align.whole_logits(audio)
    per_frame = audio.shape[-1] / log_probs.shape[1] / align.SAMPLE_RATE * 1000
    best = log_probs[0].argmax(dim=-1).tolist()
    table, _ = align.load()
    name = {two: one for one, two in table.items()}
    blank = align._bag()["blank"]
    out: list[tuple[str, int]] = []
    last = -1
    for at, one in enumerate(best):
        if one != last and one != blank:
            said = name.get(one, "")
            if said and not said.startswith("<") and said not in "|[]":
                out.append((said, int(at * per_frame)))
        last = one
    return out


def jamo(rows: list[tuple[str, int]]) -> tuple[str, list[int]]:
    """Break syllables into their letters, keeping what each letter came from.

    Hangul syllables rarely survive a bad transcript intact, but their letters often do — 조이 and
    조용 share ㅈㅗ. Matching on letters lets a half-heard syllable still pull its weight.

    @param {list[tuple[str, int]]} rows - Syllables paired with whatever they carry.
    @returns {tuple[str, list[int]]} The letters, and each letter's index back into `rows`.
    """
    letters: list[str] = []
    came: list[int] = []
    for at, (one, _) in enumerate(rows):
        for letter in unicodedata.normalize("NFD", one):
            letters.append(letter)
            came.append(at)
    return "".join(letters), came


def anchors(lines: list[dict], said: list[tuple[str, int]]) -> list[int | None]:
    """Give each lyric line the time of the sound that best matches its syllables.

    A bad transcript still matches the sheet in scattered places by accident — two letters shared
    with a line that is sung ninety seconds away is enough. Trusting those put three songs out by
    over a minute (파란달팽이 148 s), because a repeated lyric caught the wrong repeat. So only
    runs of at least `SOLID` letters count, and where a line sits inside several of them the
    longest one wins: a long run is hard to hit by chance.

    Lines no solid run reaches are filled in between the ones that have anchors, in proportion to
    how many syllables each carries. That is `guess_clock`'s spreading, but between two points the
    audio actually vouches for rather than across a whole song.

    @param {list[dict]} lines - Lyric lines, in order.
    @param {list[tuple[str, int]]} said - What the model heard, and when.
    @returns {list[int | None]} A start in ms per line, None where nothing could be placed.
    """
    sheet: list[tuple[str, int]] = []
    for at, line in enumerate(lines):
        for word in words_of(line.get("text", "")):
            for grain in align.grains_of(align.speakable(word)):
                sheet.append((grain, at))
    mine, from_mine = jamo(sheet)
    yours, from_yours = jamo(said)
    if not mine or not yours:
        return [None] * len(lines)

    #: autojunk 은 흔한 자모를 통째로 버려서 긴 노래에서 짝을 못 찾는다.
    blocks = difflib.SequenceMatcher(None, mine, yours, autojunk=False).get_matching_blocks()
    best: dict[int, tuple[int, int]] = {}
    for a, b, size in blocks:
        if size < SOLID:
            continue
        for step in range(size):
            line = sheet[from_mine[a + step]][1]
            when = said[from_yours[b + step]][1]
            was = best.get(line)
            if was is None or size > was[0] or (size == was[0] and when < was[1]):
                best[line] = (size, when)

    out: list[int | None] = [best[at][1] if at in best else None for at in range(len(lines))]
    #: 짝은 차례대로 나오지만 한 줄이 여러 짝에 걸리면 뒤집힐 수 있다. 뒤로 못 가는 것만 남긴다.
    seen = -1
    for at, one in enumerate(out):
        if one is None:
            continue
        if one < seen:
            out[at] = None
        else:
            seen = one
    return fill_between(lines, out)


def fill_between(lines: list[dict], out: list[int | None]) -> list[int | None]:
    """Spread the un-anchored lines across the gaps between anchored ones.

    @param {list[dict]} lines - Lyric lines, in order.
    @param {list[int | None]} out - Anchors, with holes.
    @returns {list[int | None]} The same list with the holes filled where two anchors bracket them.
    """
    weight = [max(1, sum(len(align.grains_of(align.speakable(word)))
                         for word in words_of(one.get("text", "")))) for one in lines]
    pinned = [at for at, one in enumerate(out) if one is not None]
    for left, right in zip(pinned, pinned[1:]):
        room = out[right] - out[left]
        total = sum(weight[left:right]) or 1
        gone = 0
        for at in range(left + 1, right):
            gone += weight[at - 1]
            out[at] = out[left] + int(room * gone / total)
    return out


def score(guess: list[int | None], truth: list[int | None]) -> tuple[int, list[int]]:
    """How far each guessed line start sits from the real one.

    @param {list[int | None]} guess - Guessed starts in ms.
    @param {list[int | None]} truth - Starts from the sheet, in ms.
    @returns {tuple[int, list[int]]} How many lines were guessed, and each gap in ms.
    """
    gaps = [abs(a - b) for a, b in zip(guess, truth) if a is not None and b is not None]
    return sum(1 for one in guess if one is not None), sorted(gaps)


def main() -> int:
    """Compare the heard anchor against `guess_clock`, both against the sheet's own times.

    @returns {int} 0 always.
    """
    want = {int(one) for one in sys.argv[1:]}
    with urllib.request.urlopen(f"{BASE}/api/songs", timeout=60) as got:
        songs = sorted(json.load(got), key=lambda one: one["id"])
    every: dict[str, list[int]] = {"들은 닻": [], "지금 짐작": []}
    print(f"  {'곡':<24} {'줄':>4} {'들은 닻':>18} {'지금 짐작':>18}")
    for song in songs:
        if want and song["id"] not in want:
            continue
        found = align.source_in(HERE / "audio", song["video_id"])
        if not found or not found.with_suffix(".lead.wav").exists():
            continue
        with urllib.request.urlopen(f"{BASE}/api/songs/{song['id']}", timeout=60) as got:
            lines = json.load(got)["lines"]
        truth = [one.get("at") for one in lines]
        if sum(1 for one in truth if one is not None) < 4:
            continue

        mine = anchors(lines, heard(found.with_suffix(".lead.wav")))
        old = align.guess_clock(found, lines, words_of)
        rows = {"들은 닻": mine, "지금 짐작": old or [None] * len(lines)}
        say = []
        for name, guess in rows.items():
            hit, gaps = score(guess, truth)
            every[name].extend(gaps)
            say.append(f"{hit:>3}줄 {gaps[len(gaps) // 2] if gaps else 0:>6}ms" if gaps else "  못 잼")
        print(f"  [{song['id']:>2}] {song['title'][:16]:<18} {len(lines):>4} "
              + "  ".join(f"{one:>18}" for one in say))
        with torch.no_grad():
            torch.mps.empty_cache()

    print()
    for name, gaps in every.items():
        if not gaps:
            continue
        gaps.sort()
        near = " · ".join(f"{one // 1000}초 안 {sum(1 for two in gaps if two <= one) / len(gaps) * 100:.0f}%"
                          for one in NEAR)
        print(f"  {name:<8} {len(gaps):>4}줄 · 가운뎃값 {gaps[len(gaps) // 2]:>6}ms · {near}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
