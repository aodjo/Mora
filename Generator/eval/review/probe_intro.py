#!/usr/bin/env python3
"""**곡 앞에 가사 없는 소리가 있으면 어떻게 되나.** 하치와레girl 한 곡을 뜯어본다.

이 곡만 닻이 안 선다. 어긋남이 **-13.4 초, 앞으로** 밀려 있으니 가사 첫 줄이 진짜 첫 소절이
아니라 그 앞의 무언가에 붙은 것이다. 받아쓰기를 보면 앞머리가 가사와 하나도 안 닮은 소리로
가득하다 — 노래 시작 전의 중얼거림, 가사장에는 없는 것.

강제정렬은 준 가사를 소리 전체에 반드시 다 펼쳐야 하므로 그 중얼거림 위에도 가사를 놓는다.
`guess_clock` 도 마찬가지다: 화자분리가 「누가 소리 낸다」고 한 구간에 줄을 고르게 뿌리는데,
중얼거림도 사람 소리라 거기에 자리를 내준다. 그래서 짐작 자체가 앞으로 당겨지고, 그 당겨진
짐작이 **옳은 닻을 거부한다** — 검문이 가장 필요한 곳에서 가장 약하다.

여기서 보는 것: 받아쓰기 앞머리가 가사와 얼마나 안 닮았는지, 화자분리가 부른다고 한 구간이
어디부터인지, 첫 줄의 진짜 시각은 언제인지, 그리고 닻이 몇 개나 서고 몇 개가 검문에 걸리는지.

@example
  python probe_intro.py 11
"""
import difflib
import json
import os
import re
import sqlite3
import sys
import unicodedata
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402

NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")


def words_of(text: str) -> list[str]:
    """Split a line into the words the aligner uses, dropping marks that carry no sound.

    @param {str} text - One lyric line.
    @returns {list[str]} Words worth aligning.
    """
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def main() -> int:
    """Lay the transcript, the diarizer's stretches and the sheet's own times side by side.

    @returns {int} 0 always.
    """
    which = int(sys.argv[1]) if len(sys.argv) > 1 else 11
    conn = sqlite3.connect(HERE / os.environ.get("MORA_DB", "review.db"))
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM songs WHERE id=?", (which,)).fetchone()
    lines = json.loads(row["lines"])
    found = align.source_in(HERE / "audio", row["video_id"])
    print(f"  [{which}] {row['title']}  ·  {row['duration']:.0f}초  ·  {len(lines)}줄\n")

    lead = found.with_suffix(".lead.wav")
    sheet0: list[tuple[str, int]] = []
    for at, line in enumerate(lines):
        for word in words_of(line.get("text", "")):
            for grain in align.grains_of(align.speakable(word)):
                sheet0.append((grain, at))
    said, alike = align.best_heard(lead, align.jamo_of(sheet0)[0], lines, words_of)
    print(f"  받아쓰기 닮은 만큼 {alike * 100:.0f}%  ·  가사장이 말하는 말 {align.tongue_of(lines, words_of)}")
    print("  ── 받아쓰기 앞머리 ──")
    for one, at in said[:22]:
        print(f"    {at / 1000:7.2f}s  {one}")

    print("\n  ── 가사 첫 줄들과 그 시각 ──")
    for at, line in enumerate(lines[:6]):
        when = line.get("at")
        print(f"    {at:>2}  {when / 1000 if when is not None else -1:7.2f}s  {line.get('text', '')[:44]}")

    quiet = align.quiet_of(found)
    spans = sorted((a, b) for one in align.voices_apart(found).get("쪽", []) for a, b in one["토막"])
    print(f"\n  ── 화자분리가 소리 난다고 한 첫 구간들 ──")
    for a, b in spans[:8]:
        print(f"    {a:7.2f}s ~ {b:7.2f}s")
    print(f"    (쉼 {len(quiet)}개)")

    coarse = align.guess_clock(found, lines, words_of)
    print(f"\n  ── 고른 짐작이 잡은 첫 줄들 ──")
    for at in range(min(6, len(lines))):
        real = lines[at].get("at")
        gap = f"{(coarse[at] - real) / 1000:+6.2f}s" if real is not None and coarse else "   ?  "
        print(f"    {at:>2}  짐작 {coarse[at] / 1000 if coarse else -1:7.2f}s   진짜 "
              f"{real / 1000 if real is not None else -1:7.2f}s   차 {gap}")

    #: 닻이 몇 개 서고 몇 개가 검문에 걸리는지.
    sheet: list[tuple[str, int]] = []
    for at, line in enumerate(lines):
        for word in words_of(line.get("text", "")):
            for grain in align.grains_of(align.speakable(word)):
                sheet.append((grain, at))
    mine, from_mine = align.jamo_of(sheet)
    yours, from_yours = align.jamo_of(said)
    blocks = difflib.SequenceMatcher(None, mine, yours, autojunk=False).get_matching_blocks()
    solid = [one for one in blocks if one.size >= align.HEARD_SOLID]
    best: dict[int, tuple[int, int]] = {}
    for a, b, size in solid:
        for step in range(size):
            line = sheet[from_mine[a + step]][1]
            when = said[from_yours[b + step]][1]
            was = best.get(line)
            if was is None or size > was[0] or (size == was[0] and when < was[1]):
                best[line] = (size, when)
    trust = alike >= align.HEARD_TRUST_ALIKE
    kept = vetoed = 0
    seen = -1
    for at in sorted(best):
        when = best[at][1]
        if when < seen or (not trust and coarse and abs(when - coarse[at]) > align.HEARD_APART_MS):
            vetoed += 1
        else:
            kept += 1
            seen = when
    need = max(2, -(-len(lines) * align.HEARD_LEAST_PCT // 100))
    print(f"\n  ── 닻 ──")
    print(f"    받아쓰기를 믿나 {'믿음' if trust else '못 믿음 — 짐작이 검문함'} "
          f"(닮은 만큼 {alike * 100:.0f}% · 문턱 {align.HEARD_TRUST_ALIKE * 100:.0f}%)")
    print(f"    짝 지은 줄 {len(best)} · 통과 {kept} · 걸림 {vetoed}")
    print(f"    바닥선 {need} → {'믿음' if kept >= need else '물러섬'}")
    if kept >= need:
        print(f"\n  ── 닻이 잡은 첫 줄들 ──")
        seen = -1
        shown = 0
        for at in sorted(best):
            when = best[at][1]
            if when < seen or (not trust and coarse and abs(when - coarse[at]) > align.HEARD_APART_MS):
                continue
            seen = when
            real = lines[at].get("at")
            gap = f"{(when - real) / 1000:+6.2f}s" if real is not None else "   ?  "
            print(f"    {at:>2}  닻 {when / 1000:7.2f}s   진짜 "
                  f"{real / 1000 if real is not None else -1:7.2f}s   차 {gap}")
            shown += 1
            if shown >= 8:
                break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
