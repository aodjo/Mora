#!/usr/bin/env python3
"""**받아쓰기가 얼마나 못 알아듣나.** 들은 것을 가사와 나란히 놓고 센다.

`heard_clock` 은 받아쓰기를 닻으로만 쓰므로 글자가 틀려도 된다 — 필요한 것은 소리가 닮았다는
것뿐이다. 그런데 열세 곡 가운데 닻이 실제로 든 곡은 넷뿐이었고, 나머지는 못이 열다섯 할에 못
미쳐 물러섰다. 그 바닥선에 걸린 까닭이 **받아쓰기가 너무 못 알아들어서**라면, 더 나은 모델을
쓰면 닻이 드는 곡이 늘어난다. 그러니 지금 얼마나 못 알아듣는지부터 재야 한다.

자는 둘이다. **닮은 만큼**은 들은 자모와 가사 자모가 겹치는 비율이고 — 닻은 이것만 쓴다 —
**받아 적은 만큼**은 들은 음절 수를 가사 음절 수로 나눈 것이다. 뒤엣것이 낮으면 모델이 아예 말을
못 알아들은 것이라 겹칠 자모 자체가 없다.

@example
  python probe_said.py            # 열세 곡, 셈만
  python probe_said.py --show 9   # 붉은 노을이 뭐라고 들었는지 보여 준다
"""
import difflib
import json
import os
import re
import sys
import unicodedata
import urllib.request
from pathlib import Path

os.environ.setdefault("MORA_ACOUSTIC", "kresnik")

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402

#: 어디서 읽나.
BASE = "http://127.0.0.1:8787"
#: 소리 없는 표시.
NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")


def words_of(text: str) -> list[str]:
    """Split a line into the words the aligner uses, dropping marks that carry no sound.

    @param {str} text - One lyric line.
    @returns {list[str]} Words worth aligning.
    """
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def letters(text: str) -> str:
    """Break Hangul syllables into their letters.

    @param {str} text - Syllables.
    @returns {str} The letters they are made of.
    """
    return unicodedata.normalize("NFD", text)


def main() -> int:
    """Print how much of each song the model actually made out.

    @returns {int} 0 always.
    """
    show = {int(one) for one in sys.argv[1:] if one.isdigit()} if "--show" in sys.argv else set()
    with urllib.request.urlopen(f"{BASE}/api/songs", timeout=60) as got:
        songs = sorted(json.load(got), key=lambda one: one["id"])
    print(f"  {'곡':<24} {'가사 음절':>8} {'들은 음절':>8} {'받아 적은 만큼':>12} {'닮은 만큼':>10}")
    every: list[tuple[float, float]] = []
    for song in songs:
        found = align.source_in(HERE / "audio", song["video_id"])
        if not found or not found.with_suffix(".lead.wav").exists():
            continue
        with urllib.request.urlopen(f"{BASE}/api/songs/{song['id']}", timeout=60) as got:
            lines = json.load(got)["lines"]
        sheet = "".join(grain for line in lines for word in words_of(line.get("text", ""))
                        for grain in align.grains_of(align.speakable(word)))
        said = "".join(one for one, _ in align.heard_song(found.with_suffix(".lead.wav")))
        if not sheet:
            continue
        wrote = len(said) / len(sheet)
        #: 겹치는 자모를 가사 자모로 나눈다. 닻이 실제로 기대는 값이다.
        blocks = difflib.SequenceMatcher(None, letters(sheet), letters(said), autojunk=False)
        alike = sum(one.size for one in blocks.get_matching_blocks()) / len(letters(sheet))
        every.append((wrote, alike))
        print(f"  [{song['id']:>2}] {song['title'][:16]:<18} {len(sheet):>8} {len(said):>8} "
              f"{wrote * 100:>11.0f}% {alike * 100:>9.0f}%")
        if song["id"] in show:
            print(f"\n       가사 · {sheet[:90]}")
            print(f"       들음 · {said[:90]}\n")
    if every:
        wrote = sorted(one for one, _ in every)
        alike = sorted(two for _, two in every)
        print(f"\n  가운뎃값 · 받아 적은 만큼 {wrote[len(wrote) // 2] * 100:.0f}% · "
              f"닮은 만큼 {alike[len(alike) // 2] * 100:.0f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
