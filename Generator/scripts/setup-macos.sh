#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
MORA_ROOT="${SCRIPT_DIR:h:h}"
PYTHON_BIN="${MORA_PYTHON_BOOTSTRAP:-/opt/homebrew/bin/python3.12}"
VENV_DIR="${MORA_ROOT}/Generator/.venv"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  print -u2 "This installer requires an Apple Silicon Mac."
  exit 1
fi

if [[ ! -x "${PYTHON_BIN}" ]]; then
  if ! command -v brew >/dev/null 2>&1; then
    print -u2 "Homebrew is required to install Python 3.12."
    exit 1
  fi
  brew install python@3.12
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  if ! command -v brew >/dev/null 2>&1; then
    print -u2 "Homebrew is required to install FFmpeg."
    exit 1
  fi
  brew install ffmpeg
fi

"${PYTHON_BIN}" -m venv "${VENV_DIR}"
"${VENV_DIR}/bin/python" -m pip install --upgrade pip setuptools wheel
"${VENV_DIR}/bin/python" -m pip install -e "${MORA_ROOT}/Generator/python[apple]"

cd "${MORA_ROOT}"
corepack pnpm install --frozen-lockfile
corepack pnpm build:services

MORA_SELF_TEST=1 \
MORA_PYTHON="${VENV_DIR}/bin/python" \
MORA_ML_DAEMON_SCRIPT="${MORA_ROOT}/Generator/python/mora_ml_daemon.py" \
PYTORCH_ENABLE_MPS_FALLBACK=1 \
PATH="${VENV_DIR}/bin:${PATH}" \
node "${MORA_ROOT}/dist/Generator/src/worker-cli.js"
