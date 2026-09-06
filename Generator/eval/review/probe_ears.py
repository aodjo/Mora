#!/usr/bin/env python3
"""**받아쓰기를 어떻게 하면 가사와 더 닮나.** 세 가지를 같은 자로 견준다.

닻은 받아쓰기가 가사와 자모 30% 넘게 닮아야 선다. whisper 로 바꿔 가운뎃값이 81% 가 됐지만
곡별로는 17~98% 로 벌어져 있고, 낮은 곡이 닻을 못 세운다. 그러니 받아쓰기를 더 낫게 하는 것이
아직 가장 큰 지렛대다.

여기서 보는 셋은 모두 **지어내는 것을 줄이는** 쪽이다. 지금 whisper 는 조용한 데서 없는 말을
쓴다 — `한글자막 by 한효주`, `안녕하세요 그런데요 저 안녕` — 그리고 닻이 거기 설 수 있다.

  목소리 문 : faster-whisper 의 `vad_filter`. 목소리가 없는 토막을 아예 안 읽는다.
  쉼 지우기 : 화자분리가 아무도 안 부른다고 한 구간을 0 으로 만든다. 시각은 그대로 두므로
              돌아온 시각을 그대로 쓸 수 있다. 문보다 우리 곡에 맞춘 잣대다.
  갈래 바꾸기: 리드 대신 보컬 통째. 리드/백 가르기가 틀린 곡에서는 이쪽이 나을 수 있다.

**가사를 미리 알려주는 것(`initial_prompt`)은 여기서 재면 안 된다.** 그것은 모델에게 답을
알려주는 것이라 「닮은 만큼」이 저절로 오른다. 그 방법은 쌩 가사 끝값으로만 판단해야 한다.

@example
  python probe_ears.py            # 열세 곡
  python probe_ears.py 7 11       # 이 두 곡만
"""
import json
import os
import re
import subprocess
import sqlite3
import sys
import wave
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402

#: 받아쓰기가 사는 두름.
EARS_PY = Path.home() / "ears/bin/python"
#: 만든 소리를 잠깐 두는 곳.
SCRATCH = Path(os.environ.get("MORA_SCRATCH", "/tmp"))
#: 소리 없는 표시.
NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")


def words_of(text: str) -> list[str]:
    """Split a line into the words the aligner uses, dropping marks that carry no sound.

    @param {str} text - One lyric line.
    @returns {list[str]} Words worth aligning.
    """
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def hushed(path: Path, quiet: list[tuple[int, int]], into: Path) -> Path:
    """Write a copy of the audio with the rests silenced, keeping every time where it was.

    Cutting the rests out would shift everything after them and the times would have to be mapped
    back. Zeroing keeps the clock honest.

    @param {Path} path - The stem to copy.
    @param {list[tuple[int, int]]} quiet - Stretches nobody sings in, in ms.
    @param {Path} into - Where to write.
    @returns {Path} The written file.
    """
    with wave.open(str(path), "rb") as got:
        rate, width, channels = got.getframerate(), got.getsampwidth(), got.getnchannels()
        frames = bytearray(got.readframes(got.getnframes()))
    step = width * channels
    for since, until in quiet:
        a = min(len(frames), int(since / 1000 * rate) * step)
        b = min(len(frames), int(until / 1000 * rate) * step)
        frames[a:b] = bytes(b - a)
    with wave.open(str(into), "wb") as put:
        put.setnchannels(channels)
        put.setsampwidth(width)
        put.setframerate(rate)
        put.writeframes(bytes(frames))
    return into


def said_by(path: Path, vad: bool = False) -> list[tuple[str, int]]:
    """Transcribe one file, optionally with the voice gate on.

    @param {Path} path - The audio to read.
    @param {bool} [vad=False] - Whether to drop stretches with no voice in them.
    @returns {list[tuple[str, int]]} Each word heard, and the ms at which it starts.
    """
    ran = subprocess.run([str(EARS_PY), str(HERE / "hear.py")],
                         input=json.dumps({"path": str(path), "vad": vad}),
                         capture_output=True, text=True)
    if ran.returncode != 0 or not ran.stdout.strip():
        return []
    return [(one, at) for one, at in json.loads(ran.stdout).get("낱말", [])]


def main() -> int:
    """Transcribe every song several ways and print how much of the sheet each recovered.

    @returns {int} 0 always.
    """
    want = {int(one) for one in sys.argv[1:]}
    conn = sqlite3.connect(HERE / os.environ.get("MORA_DB", "review.db"))
    conn.row_factory = sqlite3.Row
    songs = conn.execute("SELECT * FROM songs ORDER BY id").fetchall()
    ways = ["리드", "리드+문", "리드+쉼지움", "보컬", "보컬+문"]
    print(f"  {'곡':<20} " + " ".join(f"{one:>11}" for one in ways))
    tally: dict[str, list[float]] = {one: [] for one in ways}

    for row in songs:
        if want and row["id"] not in want:
            continue
        found = align.source_in(HERE / "audio", row["video_id"])
        lead = found.with_suffix(".lead.wav") if found else None
        if not found or not lead.exists():
            continue
        lines = json.loads(row["lines"])
        sheet = "".join(grain for line in lines for word in words_of(line.get("text", ""))
                        for grain in align.grains_of(align.speakable(word)))
        if not sheet:
            continue
        mine = align.jamo_of([(sheet, 0)])[0]

        vocals = align.vocals_of(found)
        hush = hushed(lead, align.quiet_of(found), SCRATCH / f"{row['video_id']}.hush.wav")
        got = {
            "리드": said_by(lead),
            "리드+문": said_by(lead, vad=True),
            "리드+쉼지움": said_by(hush),
            "보컬": said_by(vocals) if vocals.exists() else [],
            "보컬+문": said_by(vocals, vad=True) if vocals.exists() else [],
        }
        hush.unlink(missing_ok=True)
        say = []
        for one in ways:
            alike = align.alike_of(mine, align.jamo_of(got[one])[0]) if got[one] else 0.0
            tally[one].append(alike)
            say.append(f"{alike * 100:>10.0f}%")
        print(f"  [{row['id']:>2}] {row['title'][:14]:<15} " + " ".join(say), flush=True)

    print()
    for one in ways:
        rows = sorted(tally[one])
        if rows:
            print(f"  {one:<12} 가운뎃값 {rows[len(rows) // 2] * 100:>3.0f}% · "
                  f"30% 넘는 곡 {sum(1 for two in rows if two >= 0.30)}/{len(rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
