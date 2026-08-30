#!/usr/bin/env python3
"""demucs 가 어느 장치에서 도는지, 한 곡에 얼마나 걸리는지 잰다.

Intel Arc(xpu)는 연산 하나만 없어도 그 자리에서 죽는다. 되는지 여기서 먼저 보고,
안 되면 CPU 로 물러선다 — 55 곡을 돌리기 전에 알아야 할 일이다.
"""
import sys
import time
from pathlib import Path

import torch

HERE = Path(__file__).parent
where = sys.argv[1] if len(sys.argv) > 1 else ("xpu" if torch.xpu.is_available() else "cpu")
seconds = int(sys.argv[2]) if len(sys.argv) > 2 else 30

found = sorted(p for p in (HERE / "audio").glob("*.m4a"))
if not found:
    raise SystemExit("음원이 없다")

sys.path.insert(0, str(HERE))
import align  # noqa: E402

print(f"장치 {where} · {found[0].name} · 앞 {seconds}초만")
audio = align.read_audio(found[0])[..., : seconds * align.SAMPLE_RATE]

from demucs.apply import apply_model  # noqa: E402
from demucs.pretrained import get_model  # noqa: E402

began = time.time()
#: 반주를 걷을 모델. `htdemucs_ft` 는 네 모델을 겹쳐 돌려 네 배 걸리는데, 맞추기에 쓸
#: 보컬이라 `htdemucs` 로 넉넉하다.
model = get_model("htdemucs")
print(f"  모델 올리기 {time.time() - began:.1f}초 · 소스 {model.sources}")

import torchaudio.functional as AF  # noqa: E402

#: 넘길 소리. demucs 는 모델이 훈련된 표본율(44.1 kHz)과 두 갈래를 바란다.
wave = AF.resample(audio, align.SAMPLE_RATE, model.samplerate)
wave = wave.repeat(2, 1) if wave.shape[0] == 1 else wave

began = time.time()
try:
    with torch.inference_mode():
        stems = apply_model(model.to(where), wave[None].to(where), device=where, progress=False)
    spent = time.time() - began
    vocals = stems[0, model.sources.index("vocals")]
    print(f"  가르기 {spent:.1f}초 ({seconds}초 소리 → 실시간의 {spent / seconds:.1f}배)")
    print(f"  보컬 {tuple(vocals.shape)} · 크기 {float(vocals.abs().mean()):.4f}")
    print(f"  → 4분 곡이면 약 {spent / seconds * 240 / 60:.1f}분")
except Exception as error:
    print(f"  ✗ {where} 에서 실패: {type(error).__name__}: {str(error)[:200]}")
