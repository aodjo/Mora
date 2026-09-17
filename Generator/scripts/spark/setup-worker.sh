#!/usr/bin/env bash
# DGX Spark(aarch64 · GB10 · CUDA 13 드라이버)를 Generator 워커로 세운다 — 순서 2/3. 이미지는 amd64 뿐이라 직접 짓는다.
#   노드 · 저장소(~/mora-gen/Mora) · 워커 파이썬(torch 2.8 cu129 aarch64 — GB10 은 12.1 이라 경고만 내고 돈다).
#   curl -fsSL https://raw.githubusercontent.com/aodjo/Mora/main/Generator/scripts/spark/setup-worker.sh | bash
# 그다음 build-ctranslate2.sh(3/3), 띄우기는 start-worker.sh.
set -eu
ROOT=$HOME/mora-gen
LOG=$ROOT/logs/setup.log
mkdir -p "$ROOT/logs"
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
export PATH="$ROOT/node/bin:$HOME/.local/bin:$PATH" UV_LINK_MODE=copy
# sphn(demucs 4.1 이 끌어옴)의 audiopus_sys 가 cmake_minimum_required 가 낡아 CMake 4 에서 멈춘다.
export CMAKE_POLICY_VERSION_MINIMUM=3.5

if [ ! -x "$ROOT/node/bin/node" ]; then
  say "노드"
  mkdir -p "$ROOT/node"
  curl -fsSL https://nodejs.org/dist/v24.20.0/node-v24.20.0-linux-arm64.tar.xz | tar -xJ -C "$ROOT/node" --strip-components=1 --no-same-owner
fi
corepack enable >>"$LOG" 2>&1 || true
say "  node $(node -v)"

say "저장소"
[ -d "$ROOT/Mora/.git" ] || git clone -q https://github.com/aodjo/Mora.git "$ROOT/Mora" >>"$LOG" 2>&1
git -C "$ROOT/Mora" checkout -q -- Admin test 2>/dev/null || true
git -C "$ROOT/Mora" pull -q --ff-only origin main >>"$LOG" 2>&1
rm -rf "$ROOT/Mora/Admin" "$ROOT/Mora/test"
say "  $(git -C "$ROOT/Mora" log --oneline -1)"

say "노드 의존 + 빌드"
( cd "$ROOT/Mora" && CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --frozen-lockfile >>"$LOG" 2>&1 \
  && CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm build:services >>"$LOG" 2>&1 )
[ -f "$ROOT/Mora/dist/Generator/src/worker-cli.js" ] || { say "✖ worker-cli 가 없다"; exit 1; }

say "워커 파이썬 (torch 2.8 cu129 aarch64 · whisperx · demucs · audio-separator)"
VENV=$ROOT/Mora/Generator/.venv
[ -x "$VENV/bin/python" ] || uv venv -q --python 3.12 --seed "$VENV" >>"$LOG" 2>&1
uv pip install -q --python "$VENV/bin/python" --index-url https://download.pytorch.org/whl/cu129 \
  torch==2.8.0 torchaudio==2.8.0 >>"$LOG" 2>&1
# onnxruntime 1.22 이상은 spark 에서 불러오는 순간 죽었다. audio-separator 가 모듈 단계에서 부른다.
uv pip install -q --python "$VENV/bin/python" "$ROOT/Mora/Generator/python" onnxruntime==1.20.1 \
  --index-strategy unsafe-best-match --extra-index-url https://download.pytorch.org/whl/cu129 >>"$LOG" 2>&1
"$VENV/bin/python" - <<'EOF' 2>&1 | tee -a "$LOG"
import torch
print("torch", torch.__version__, "cuda", torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else "")
x = torch.randn(512, 512, device="cuda"); print("  matmul", float((x @ x).sum()) != 0)
import whisperx, demucs, audio_separator, ctranslate2
print("  whisperx ok · ctranslate2", ctranslate2.__version__, "cuda devices", ctranslate2.get_cuda_device_count())
EOF
say "  self-test"
( cd "$ROOT/Mora" && echo '{"jsonrpc":"2.0","id":1,"method":"self_test"}' | "$VENV/bin/python" Generator/python/mora_ml_daemon.py 2>>"$LOG" | tail -1 | tee -a "$LOG" ) || true
du -sh "$VENV" | tee -a "$LOG"
say "끝"
echo 끝 > "$ROOT/setup.done"
