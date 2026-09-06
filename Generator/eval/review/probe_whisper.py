#!/usr/bin/env python3
"""**더 나은 받아쓰기를 쓰면 닻이 더 서나.** kresnik 과 whisper 를 같은 자로 견준다.

`probe_said` 가 보인 것: 닻은 자모가 30% 넘게 닮았을 때만 서고, kresnik 의 가운뎃값은 13% 다.
그러니 닻이 열세 곡 가운데 넷에서만 든 까닭은 셈법이 아니라 **받아쓰기가 못 알아들어서**다.
kresnik 은 한글 음절 1202 개가 어휘의 전부라 영어를 아예 못 적는다 — Small girl 이 4% 인 것이
그래서다.

whisper-large-v3 은 한국어와 영어를 함께 하고 낱말마다 시각을 준다. 재는 것은 하나: 같은 곡을
두 모델로 받아 적고, 가사와 얼마나 닮았는지를 견준다. 닮은 만큼이 30% 를 넘는 곡이 늘면 닻도
그만큼 더 서고, 안 늘면 받아쓰기를 바꿔도 소용없다는 뜻이다.

@example
  python probe_whisper.py            # 열세 곡
  python probe_whisper.py 9 11       # 이 두 곡만
"""
import difflib
import json
import os
import re
import subprocess
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
#: 받아쓰기가 사는 두름.
EARS_PY = Path.home() / "ears/bin/python"
#: 소리 없는 표시.
NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")


def words_of(text: str) -> list[str]:
    """Split a line into the words the aligner uses, dropping marks that carry no sound.

    @param {str} text - One lyric line.
    @returns {list[str]} Words worth aligning.
    """
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def whispered(path: Path) -> list[tuple[str, int]]:
    """Transcribe the lead stem in the `~/ears` venv, returning each word and when it starts.

    mlx has nothing to do with torch, but it lives apart for the same reason `~/dia` and `~/qwen`
    do — one venv changing another's pinned versions has broken all three before.

    @param {Path} path - The lead vocal stem.
    @returns {list[tuple[str, int]]} Each word heard, and the ms at which it starts.
    """
    ran = subprocess.run([str(EARS_PY), str(HERE / "hear.py")],
                         input=json.dumps({"path": str(path)}), capture_output=True, text=True)
    if ran.returncode != 0 or not ran.stdout.strip():
        return []
    said = json.loads(ran.stdout)
    return [(one, at) for one, at in said.get("낱말", [])]


def alike(sheet: str, said: str) -> float:
    """What share of the sheet's letters the transcript also has, in order.

    @param {str} sheet - The lyric syllables, run together.
    @param {str} said - The transcribed syllables, run together.
    @returns {float} Overlap as a share of the sheet, 0 to 1.
    """
    mine, yours = unicodedata.normalize("NFD", sheet), unicodedata.normalize("NFD", said)
    if not mine or not yours:
        return 0.0
    blocks = difflib.SequenceMatcher(None, mine, yours, autojunk=False).get_matching_blocks()
    return sum(one.size for one in blocks) / len(mine)


def main() -> int:
    """Transcribe every song both ways and print how much each made out.

    @returns {int} 0 always.
    """
    want = {int(one) for one in sys.argv[1:]}
    with urllib.request.urlopen(f"{BASE}/api/songs", timeout=60) as got:
        songs = sorted(json.load(got), key=lambda one: one["id"])
    print(f"  {'곡':<24} {'가사 음절':>8} {'kresnik':>9} {'whisper':>9}  {'닻 서나':>8}")
    rows: list[tuple[float, float]] = []
    for song in songs:
        if want and song["id"] not in want:
            continue
        found = align.source_in(HERE / "audio", song["video_id"])
        if not found or not found.with_suffix(".lead.wav").exists():
            continue
        with urllib.request.urlopen(f"{BASE}/api/songs/{song['id']}", timeout=60) as got:
            lines = json.load(got)["lines"]
        sheet = "".join(grain for line in lines for word in words_of(line.get("text", ""))
                        for grain in align.grains_of(align.speakable(word)))
        if not sheet:
            continue
        lead = found.with_suffix(".lead.wav")
        was = alike(sheet, "".join(one for one, _ in align.heard_song(lead)))
        now = alike(sheet, "".join(one for one, _ in whispered(lead)))
        rows.append((was, now))
        #: 30% 언저리가 닻이 서기 시작하는 자리였다.
        mark = "→ 섬" if now >= 0.30 and was < 0.30 else ("섬" if now >= 0.30 else "")
        print(f"  [{song['id']:>2}] {song['title'][:16]:<18} {len(sheet):>8} "
              f"{was * 100:>8.0f}% {now * 100:>8.0f}%  {mark:>8}", flush=True)
    if rows:
        for name, at in (("kresnik", 0), ("whisper", 1)):
            got = sorted(one[at] for one in rows)
            print(f"\n  {name:<8} 가운뎃값 {got[len(got) // 2] * 100:>3.0f}% · "
                  f"30% 넘는 곡 {sum(1 for one in got if one >= 0.30)}/{len(got)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
