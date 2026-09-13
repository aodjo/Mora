#!/usr/bin/env bash
# 빌린 GPU 기계(vast.ai, 이미지 pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime)에 정렬기 살림을 차린다.
# 맥의 ~/mora-review/.venv 와 ~/qwen 과 같은 판을 깐다 — 기준 곡 11곡이 맥과 곡마다 한두 줄 안으로 맞았다.
#
# 받아쓰기(~/ears)와 화자 가르기(~/dia)는 깔지 않는다. 기준 곡은 `.heard.json`·`.vocals.dia.json` 이
# 음원 옆에 이미 있어 부르지 않는다. 새 곡을 돌리려면 둘 다 따로 깔아야 한다.
#
# 옮길 것 (맥에서):
#   tar -cf - *.py review.db audio | ssh gpu 'mkdir -p ~/mora-review && tar -xf - -C ~/mora-review'
#   학습한 무게는 ~/mora-train/models/mms_sing_b.pt
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq ffmpeg libsndfile1 build-essential >/dev/null
curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
export PATH="$HOME/.local/bin:$PATH"

mkdir -p ~/mora-review
cd ~/mora-review
uv venv -q --python 3.12 .venv
uv pip install -q --python .venv/bin/python torch==2.13.0 torchaudio==2.11.0
uv pip install -q --python .venv/bin/python uroman==1.3.1.1 soundfile numpy scipy librosa samplerate resampy pydub
.venv/bin/python -c "import torch, torchaudio; print('정렬기', torch.__version__, torchaudio.__version__, torch.cuda.is_available())"
.venv/bin/python -c "import torchaudio; torchaudio.pipelines.MMS_FA.get_model()"

#: 다듬기(refine.py)는 torch 판이 달라 딴 살림에서 돈다.
uv venv -q --python 3.12 ~/qwen
uv pip install -q --python ~/qwen/bin/python torch==2.14.0 qwen-asr==0.0.6 transformers==4.57.6 accelerate==1.12.0 soundfile librosa
~/qwen/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('Qwen/Qwen3-ForcedAligner-0.6B')"
echo "다 깔았다"
