#!/usr/bin/env python3
"""**소리를 그냥 받아 적는다.** 낱말마다 언제 나왔는지와 함께 돌려준다.

`align.heard_song` 은 kresnik 을 자유롭게 풀어 같은 일을 하지만, 그 어휘는 한글 음절 1202 개가
전부다 — 로마자가 없어 영어 가사는 아예 못 적고(Small girl 이 자모 4% 밖에 안 닮은 까닭),
한국어도 가운뎃값 13% 에 그친다. 닻은 30% 넘게 닮아야 서므로 그것이 지금의 병목이다.

whisper 는 한국어와 영어를 함께 하고 낱말마다 시각을 준다. MLX 판이라 애플 GPU 에서 바로 돌고,
무게는 이미 받아져 있다. mlx 는 torch 와 상관없지만 `~/dia`·`~/qwen` 과 같은 까닭으로 따로
떼어 둔다 — 한 두름이 다른 두름의 짝을 갈아 끼우면 셋 다 무너진다.

들어오는 것도 나가는 것도 JSON 한 줄이다.

@example
  echo '{"path": "song.lead.wav"}' | ~/ears/bin/python hear.py
"""
#: 맥의 `~/ears` 는 시스템 파이썬 3.9 로 만들어졌다. `str | None` 은 3.10 부터 실행 시점에
#: 통하므로, 이 줄이 없으면 이 파일은 맥에서 첫 함수 정의에서 죽는다 — 그리고 `heard_song`
#: 은 그것을 「받아쓰기가 없다」로 읽고 조용히 kresnik 으로 물러나, 맥에서 받아 적은 모든
#: 곡이 16% 짜리 받아쓰기로 정렬됐다. 야해가 「흉터」부터 밀린 것이 그 자국이다.
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def find_cuda() -> None:
    """Put torch's bundled CUDA libraries where CTranslate2 will find them.

    faster-whisper needs `libcublas` and `libcudnn`, which on this machine exist only inside the
    aligner's own venv, shipped with `torch+cu124`. Rather than making every caller set
    `LD_LIBRARY_PATH` first, the path is found here and the process re-executed once — the loader
    reads that variable at start-up, so setting it in a running process does nothing.

    @returns {None}
    """
    if os.environ.get("MORA_CUDA_SET"):
        return
    found = sorted(Path.home().glob("*/.venv/lib/python3*/site-packages/nvidia/*/lib"))
    if not found:
        return
    os.environ["MORA_CUDA_SET"] = "1"
    os.environ["LD_LIBRARY_PATH"] = ":".join(
        [str(one) for one in found] + [os.environ.get("LD_LIBRARY_PATH", "")])
    os.execv(sys.executable, [sys.executable] + sys.argv)


#: 애플에서는 mlx, 그 밖에서는 CUDA 를 쓰는 faster-whisper, 그것도 없으면 transformers. 같은 무게를
#: 다른 두름이 돌릴 뿐이라 부르는 쪽은 어느 것이 돌았는지 몰라도 된다. 세 번째는 spark(DGX Spark,
#: aarch64) 때문에 있다 — PyPI 의 aarch64 CTranslate2 는 CUDA 없이 지어져(장치 0) faster-whisper 가
#: CPU 두 코어로 돌고, torch 는 그 GPU 를 잘 쓴다.
WhisperModel = None
try:
    import mlx_whisper
    WHICH = "mlx-community/whisper-large-v3-mlx"
except ImportError:
    mlx_whisper = None
    import importlib.util
    if importlib.util.find_spec("faster_whisper"):
        find_cuda()
        from faster_whisper import WhisperModel
        WHICH = "large-v3"
    else:
        WHICH = "openai/whisper-large-v3"

#: 한 번 세운 모델을 붙들어 둔다. faster-whisper 는 세우는 데만 몇 초 걸린다.
_it: dict = {}

#: **온도는 0 으로 못박는다.** 두 구현 모두 기본값이 `(0, 0.2, 0.4, 0.6, 0.8, 1.0)` 이라, 압축률이나
#: 확신도가 문턱에 걸리면 온도를 올려 **샘플링으로 다시 푼다.** 그러면 같은 소리에서 판마다 다른
#: 글이 나오고, 재는 값이 따라 흔들린다 — 같은 설정으로 열세 곡을 두 번 재니 제자리 줄이 545 와
#: 557 로 갈렸다. 그 폭이 잣대를 훑어 얻은 폭(80~83%)만 해서 무엇이 나은지 가릴 수가 없었다.
#: 지어내기를 막자고 둔 되풀이지만, 재현되지 않는 것은 고칠 수가 없으므로 재현을 택한다.
STEADY = 0.0


def by_mlx(path: str, which: str, language: str | None, vad: bool = False,
           hint: str = "") -> list:
    """Transcribe on Apple silicon.

    mlx-whisper has neither a voice-activity gate nor hotwords, so `vad` and `hint` are taken and
    ignored rather than making the caller ask which machine it is talking to. `hint` could go in
    as `initial_prompt` here, but that seeds only the first window and would not mean the same
    thing as it does on the other side.

    @param {str} path - The audio to read.
    @param {str} which - Which weights to use.
    @param {str | None} language - The language to force, or None to let it choose.
    @param {bool} [vad=False] - Ignored here.
    @param {str} [hint=""] - Ignored here.
    @returns {list} Each word heard, paired with the ms at which it starts.
    """
    said = mlx_whisper.transcribe(path, path_or_hf_repo=which, language=language,
                                  word_timestamps=True, condition_on_previous_text=False,
                                  temperature=STEADY)
    return [(one["word"].strip(), int(one["start"] * 1000))
            for chunk in said.get("segments", []) for one in chunk.get("words", [])
            if one.get("word", "").strip()]


def by_cuda(path: str, which: str, language: str | None, vad: bool = False,
            hint: str = "") -> list:
    """Transcribe on an NVIDIA card.

    `hint` is handed over as **hotwords**, not as `initial_prompt`. A prompt seeds only the first
    window; with `condition_on_previous_text` off it never reaches the rest of the song, which is
    most of it. Hotwords are applied to every window.

    The laptop 3060 has 6 GB and the alignment pipeline wants most of it, so the weights go in at
    `int8_float16` — a third of the memory for no difference that this measurement can see.

    The voice-activity gate is what stops whisper writing words over silence. Left off it ends
    songs with things nobody sang — `한글자막 by 한효주`, `안녕하세요 그런데요 저 안녕` — and an
    anchor can be driven onto one of those.

    @param {str} path - The audio to read.
    @param {str} which - Which weights to use.
    @param {str | None} language - The language to force, or None to let it choose.
    @param {bool} [vad=False] - Whether to drop stretches with no voice in them.
    @param {str} [hint=""] - Words the song is known to contain, biasing what is written down.
    @returns {list} Each word heard, paired with the ms at which it starts.
    """
    if "it" not in _it:
        _it["it"] = WhisperModel(which, device="cuda", compute_type="int8_float16")
    chunks, _ = _it["it"].transcribe(path, language=language, word_timestamps=True,
                                     condition_on_previous_text=False, vad_filter=vad,
                                     temperature=STEADY, hotwords=hint or None)
    return [(one.word.strip(), int(one.start * 1000))
            for chunk in chunks for one in (chunk.words or []) if one.word.strip()]


def by_torch(path: str, which: str, language: str | None, vad: bool = False,
             hint: str = "") -> list:
    """Transcribe with transformers on any CUDA card torch can drive.

    The song is cut into 30-second windows and each is decoded on its own, which is what
    `condition_on_previous_text=False` means on the other two sides. Word times come from the
    cross-attention alignment, the same method the other two use. There is no voice-activity gate
    and no hotwords here, so `vad` and `hint` are taken and ignored.

    @param {str} path - The audio to read.
    @param {str} which - Which weights to use.
    @param {str | None} language - The language to force, or None to let it choose.
    @param {bool} [vad=False] - Ignored here.
    @param {str} [hint=""] - Ignored here.
    @returns {list} Each word heard, paired with the ms at which it starts.
    """
    import torch
    from transformers import pipeline
    if "torch" not in _it:
        _it["torch"] = pipeline("automatic-speech-recognition", model=which, dtype=torch.float16,
                                device="cuda:0")
    ask = {"task": "transcribe", "temperature": STEADY}
    if language:
        ask["language"] = language
    said = _it["torch"](path, return_timestamps="word", chunk_length_s=30, batch_size=8,
                        generate_kwargs=ask)
    return [(one["text"].strip(), int(one["timestamp"][0] * 1000))
            for one in said.get("chunks", [])
            if one.get("text", "").strip() and one.get("timestamp") and one["timestamp"][0] is not None]


def main() -> int:
    """Read a path on stdin, write the words heard and their times on stdout.

    @returns {int} 0 on success, 1 when the transcription fails.
    """
    asked = json.load(sys.stdin)
    try:
        #: 말을 안 박으면 whisper 가 스스로 고른다. 한국어로 박았더니 영어가 주인 곡
        #: (Small girl)이 자모 17% 밖에 안 닮았다 — 한글로 받아 적으려 애쓴 탓이다.
        speak = by_mlx if mlx_whisper else (by_cuda if WhisperModel else by_torch)
        out = speak(asked["path"], asked.get("which", WHICH), asked.get("language"),
                    bool(asked.get("vad")), asked.get("hint", ""))
    except Exception as trouble:  # noqa: BLE001
        json.dump({"안 됨": str(trouble)}, sys.stdout)
        return 1
    json.dump({"낱말": out}, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
