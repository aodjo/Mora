#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
MORA_ROOT="${SCRIPT_DIR:h:h}"
VENV_DIR="${MORA_ROOT}/Generator/.venv"

cd "${MORA_ROOT}"
corepack pnpm build:services
MORA_SELF_TEST=1 \
MORA_PYTHON="${VENV_DIR}/bin/python" \
MORA_ML_DAEMON_SCRIPT="${MORA_ROOT}/Generator/python/mora_ml_daemon.py" \
PYTORCH_ENABLE_MPS_FALLBACK=1 \
PATH="${VENV_DIR}/bin:${PATH}" \
node "${MORA_ROOT}/dist/Generator/src/worker-cli.js"
