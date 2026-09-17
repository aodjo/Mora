#!/usr/bin/env bash
# 노래 정렬기와 도우미 살림 셋(aligner·qwen·dia)을 DGX Spark(aarch64 · GB10 · CUDA 13)에 짓는다 — 순서 1/3.
# Generator/Dockerfile 과 같은 판인데 torch 만 ARM CUDA 13 판(2.10)이다. 2.13 aarch64 는 불러오는 순간 죽었다.
#   bash Generator/scripts/spark/build-aligner-envs.sh      (받아쓰기 살림 ~/ears 는 따로 있어야 한다)
set -eu
ROOT=${MORA_SPARK_ENVS:-$HOME/mora-val2/env}
TORCH_INDEX=https://download.pytorch.org/whl/cu130
export PATH="$HOME/.local/bin:$PATH" UV_LINK_MODE=hardlink UV_CACHE_DIR=$ROOT/.uv-cache UV_PYTHON_INSTALL_DIR=$ROOT/python
rm -rf "$ROOT/aligner" "$ROOT/qwen" "$ROOT/dia"; for name in aligner qwen dia; do uv venv -q --python 3.12 "$ROOT/$name"; done
for name in aligner qwen dia; do
  uv pip install -q --python "$ROOT/$name/bin/python" --index-url "$TORCH_INDEX" torch==2.10.0
done
uv pip install -q --python $ROOT/aligner/bin/python --index-url "$TORCH_INDEX" torchaudio==2.10.0
uv pip install -q --python $ROOT/aligner/bin/python uroman==1.3.1.1 soundfile numpy scipy librosa samplerate resampy pydub \
  "audio-separator==0.47.0" onnxruntime audioread speechbrain==1.1.1 scikit-learn==1.9.0 "yt-dlp[default]"
uv pip install -q --python $ROOT/qwen/bin/python qwen-asr==0.0.6 transformers==4.57.6 accelerate==1.12.0 soundfile librosa
uv pip install -q --python $ROOT/dia/bin/python "nemo-toolkit[asr]==3.0.0" soundfile || echo "NeMo 실패"
$ROOT/aligner/bin/python -c "import torch, torchaudio, uroman, audio_separator, sklearn; from speechbrain.inference.speaker import EncoderClassifier; print(\"정렬기\", torch.__version__, torchaudio.__version__, torch.cuda.is_available())"
$ROOT/qwen/bin/python -c "import torch, qwen_asr; print(\"qwen\", torch.__version__, torch.cuda.is_available())"
$ROOT/dia/bin/python -c "import torch, nemo; print(\"dia\", torch.__version__, nemo.__version__, torch.cuda.is_available())" || echo "dia 안 됨"
du -sh $ROOT
echo 다 지었다
