#!/usr/bin/env python3
"""**어느 보컬 모델이 목소리를 안 버리는가.**

Small girl 의 20·62 번(`(If, if I got a…)`)이 지금 쓰는 BS-Roformer 에서 통째로 사라진다 —
원본 0.375 인데 보컬 0.0002 로, 0.05% 만 남는다. 반주 걷는 단계에서 **그 목소리를 반주로
판정**하는 것이다. 리드/서브로 가르기 전에 없어지니 어느 갈래에도 안 남는다.

재는 것 셋:

1. **살아남았나** — 문제 대목에서 보컬이 원본의 몇 %인가. 높을수록 좋다.
2. **멀쩡한 대목은 그대로인가** — 다른 줄에서도 비슷해야 한다. 여기가 같이 커지면
   목소리를 살린 게 아니라 **반주까지 남긴** 것이다.
3. **곡 전체 크기** — 원본에 가까울수록 반주가 새어 든 것이다.

자리는 **밖에서 온 줄 시각**으로 잡는다. 우리 정렬로 잡으면 「줄이 간주에 놓였을 때」와
구별이 안 된다.
"""
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy
import torch

HERE = Path(__file__).parent
RATE = 16_000
# 견줄 모델들. 이름은 `audio-separator` 의 파일 이름 그대로다.
MODELS = [
    # **백보컬 전용.** BVE = Backing Vocal Extraction. 보컬 모델이 「주 목소리가 아니다」로
    # 버리는 것을 바로 이 모델이 집어내라고 만들어졌다.
    ("BVE 4B SN 1", "UVR-BVE-4B_SN-44100-1.pth"),
    ("BVE 4B SN 2", "UVR-BVE-4B_SN-44100-2.pth"),
    # 카라오케 모델을 **원본에 바로** 걸어 본다. 그 「instrumental」 쪽에는 리드를 뺀
    # 나머지가 다 들어가므로 백보컬이 살아 있을 수 있다.
    ("카라오케 aufr33 (원본에)", "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"),
    ("카라오케 gabox v2 (원본에)", "mel_band_roformer_karaoke_gabox_v2.ckpt"),
    ("카라오케 becruily (원본에)", "mel_band_roformer_karaoke_becruily.ckpt"),
    # 앞 판에서 이름 잘림 때문에 남의 결과를 쓴 셋. 제대로 다시 잰다.
    ("Kim FT2 unwa", "mel_band_roformer_kim_ft2_unwa.ckpt"),
    ("Kim FT3 unwa", "mel_band_roformer_kim_ft3_unwa.ckpt"),
    ("Kim FT2 Bleedless", "mel_band_roformer_kim_ft2_bleedless_unwa.ckpt"),
]


def read(path: Path, rate: int = RATE, channels: int = 1):
    got = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", str(path),
         "-f", "f32le", "-ac", str(channels), "-ar", str(rate), "-"],
        stdin=subprocess.DEVNULL, capture_output=True, timeout=600)
    if got.returncode != 0 or not got.stdout:
        raise RuntimeError(f"못 읽는다: {got.stderr.decode()[-200:]}")
    flat = numpy.frombuffer(got.stdout, dtype=numpy.float32).copy()
    return torch.from_numpy(flat).reshape(-1, channels).T.contiguous()


def loud(wave, since: int, until: int) -> float:
    piece = wave[since:until]
    return float(piece.pow(2).mean().sqrt()) if piece.numel() else 0.0


song = Path(sys.argv[1] if len(sys.argv) > 1 else "audio/UIBmWmDP1RU.m4a")
lines = json.loads(Path(sys.argv[2] if len(sys.argv) > 2 else "lines.json").read_text())
# 사라진다고 짚인 줄. 나머지는 견줄 바탕이 된다.
GONE = {int(one) for one in (sys.argv[3].split(",") if len(sys.argv) > 3 else ["20", "62"])}

raw = read(song)[0]
timed = [(i, one["at"]) for i, one in enumerate(lines) if one.get("at") is not None]
spans = []
for (index, at), (_, nxt) in zip(timed, timed[1:] + [(None, timed[-1][1] + 4000)]):
    since, until = int(at / 1000 * RATE), int(min(nxt, at + 8000) / 1000 * RATE)
    if until - since >= RATE // 2:
        spans.append((index, since, until))

work = Path("out")
work.mkdir(exist_ok=True)
# 원본을 wav 로 한 번만 풀어 둔다 — audio-separator 는 soundfile 로 읽어 m4a 를 못 연다.
src = work / "src.wav"
if not src.exists():
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(song),
                    "-ac", "2", "-ar", "44100", "-c:a", "pcm_s24le", str(src)], check=True)

from audio_separator.separator import Separator  # noqa: E402

print(f"  {song.name} · 줄 {len(lines)} · 사라진다고 짚인 줄 {sorted(GONE)}\n")
print(f"  {'모델':<26} {'시간':>6} {'사라진 줄':>9} {'멀쩡한 줄':>9} {'곡 전체':>8}")
for name, filename in MODELS:
    # 이름을 자르면 안 된다. `mel_band_roformer_ki…` 로 시작하는 것이 넷이라 20 자로 자르니
    # 서로 같은 파일을 가리켰고, 세 모델이 앞엣것의 결과를 그대로 재사용했다(0 초로 찍혔다).
    into = work / f"{filename.replace('/', '_')}.out.wav"
    try:
        began = time.time()
        if not into.exists():
            apart = Separator(output_dir=str(work), output_format="WAV", log_level=40)
            apart.torch_device = torch.device("cuda")
            apart.load_model(model_filename=filename)
            made = apart.separate(str(src))
            # 이름을 대소문자 가려 찾으면 안 된다. 판마다 `(Vocals)` 와 `(vocals)` 가 섞여
            # 나와, 세 모델이 「보컬 갈래가 없다」로 빠졌다.
            picked = next((one for one in made if "(vocals)" in one.lower()), None)
            if picked is None:
                print(f"  {name:<26} 보컬 갈래가 없다: {made}")
                continue
            (work / picked).rename(into)
            for one in made:
                (work / one).unlink(missing_ok=True)
        took = time.time() - began
        voice = read(into)[0]
        keeps = []
        for index, since, until in spans:
            a = loud(raw, since, until)
            b = loud(voice, since, min(until, voice.shape[-1]))
            keeps.append((index, b / max(a, 1e-9)))
        gone = [one for index, one in keeps if index in GONE]
        rest = sorted(one for index, one in keeps if index not in GONE)
        whole = float(voice.pow(2).mean().sqrt()) / max(float(raw.pow(2).mean().sqrt()), 1e-9)
        print(f"  {name:<26} {took:>5.0f}초 "
              f"{sum(gone) / max(len(gone), 1) * 100:>8.1f}% "
              f"{rest[len(rest) // 2] * 100:>8.1f}% {whole * 100:>7.1f}%", flush=True)
    except Exception as error:
        print(f"  {name:<26} 안 됨 — {type(error).__name__}: {str(error)[:60]}", flush=True)
