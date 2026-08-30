#!/usr/bin/env python3
"""**반주를 걷는 데 무엇이 나은가** — demucs 대 BS-Roformer.

지금은 demucs `htdemucs_ft` 를 쓴다. 사람이 「반주 걷어낸 게 별로」라고 했다. Roformer 계열은
보컬 분리 SDR 이 12.98 로 demucs(9~10)보다 눈에 띄게 높다.

두 가지를 잰다:

1. **얼마나 걸리나.** 곡마다 한 번이고 캐시되지만, 2 분과 10 분은 다르다.
2. **맞추기가 나아지나.** 반주가 새어 들면 노래가 멎은 자리에서도 모델이 글자를 내놓아
   줄 끝이 늘어난다. `align.flag_stuck` 이 세는 무너진 줄로 본다.

소리 자체가 나은지는 **사람이 듣고 판단한다** — 여기서는 파일만 만들어 둔다.
"""
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402

NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")
#: 반주 걷기에 쓸 Roformer 판. SDR 12.98 로 목록에서 가장 높다.
ROFORMER = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"


def words_of(text: str) -> list[str]:
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def roformer_vocals(path: Path) -> Path:
    """Roformer 로 보컬을 뽑아 `.vox.wav` 로 둔다. 원음질 그대로.

    원본을 먼저 wav 로 풀어 둔다. audio-separator 는 soundfile 로 읽어 **m4a 를 못 연다** —
    카라오케 단계에서는 이미 wav(보컬 갈래)를 넘겨서 안 걸렸다.

    나온 갈래 가운데 보컬을 고를 때는 이름이 판마다 다르니 **소리 큰 쪽이 아니라 이름**으로
    찾는다. 반주가 보컬보다 큰 것이 보통이라 여기서는 크기로 못 고른다.
    """
    made = path.with_suffix(".vox.wav")
    if made.exists():
        return made

    import torch
    from audio_separator.separator import Separator

    into = path.parent / "split"
    into.mkdir(exist_ok=True)
    raw = into / f"{path.stem}.src.wav"
    if not raw.exists():
        align.write_audio(align.read_audio(path, rate=44100, channels=2), raw, 44100)

    apart = Separator(output_dir=str(into), output_format="WAV", log_level=40)
    apart.torch_device = torch.device(align.device())
    apart.load_model(model_filename=ROFORMER)
    got = apart.separate(str(raw))

    for name in got:
        one = into / name
        if not one.exists():
            continue
        if "(Vocals)" in name:
            import subprocess
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(one),
                            "-c:a", "pcm_s24le", str(made)], check=True, timeout=600)
        one.unlink(missing_ok=True)
    raw.unlink(missing_ok=True)
    return made


def broken(got) -> int:
    return sum(1 for one in got if one and one[0].get("stuck"))


want = sys.argv[1] if len(sys.argv) > 1 else "Small"
conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
row = conn.execute(
    "SELECT id, artist, title, video_id, lines FROM songs WHERE title LIKE ? OR artist LIKE ?",
    (f"%{want}%", f"%{want}%")).fetchone()
found = align.source_in(HERE / "audio", row["video_id"])
lines = json.loads(row["lines"])
print(f"[{row['id']}] {row['artist']} — {row['title']} · 줄 {len(lines)}\n")

began = time.time()
demucs = align.vocals_of(found)
print(f"  demucs      {time.time() - began:>5.0f}초 · {demucs.name}", flush=True)

began = time.time()
rofo = roformer_vocals(found)
print(f"  BS-Roformer {time.time() - began:>5.0f}초 · {rofo.name}", flush=True)

print()
for name, stem in (("demucs", demucs), ("BS-Roformer", rofo)):
    began = time.time()
    got = align.align_song(stem, lines, words_of, separate=False)
    done = sum(1 for one in got if one)
    print(f"  {name:<12} 맞춘 줄 {done}/{len(lines)} · 무너짐 {broken(got):>2} · {time.time() - began:.0f}초")
