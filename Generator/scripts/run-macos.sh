#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
MORA_ROOT="${SCRIPT_DIR:h:h}"
ENV_FILE="${MORA_GENERATOR_ENV_FILE:-${MORA_ROOT}/Generator/.env}"
VENV_DIR="${MORA_ROOT}/Generator/.venv"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  source "${ENV_FILE}"
  set +a
else
  print "${ENV_FILE} 없음: 기본 Admin 주소와 Mac 설정을 사용합니다."
fi

MORA_CACHE_ROOT="${MORA_CACHE_ROOT:-${HOME}/Library/Caches/Mora}"
mkdir -p "${MORA_CACHE_ROOT}/huggingface" "${MORA_CACHE_ROOT}/torch" "${MORA_CACHE_ROOT}/mlx"

export HF_HOME="${HF_HOME:-${MORA_CACHE_ROOT}/huggingface}"
export TORCH_HOME="${TORCH_HOME:-${MORA_CACHE_ROOT}/torch}"
export MLX_HOME="${MLX_HOME:-${MORA_CACHE_ROOT}/mlx}"
export PYTORCH_ENABLE_MPS_FALLBACK="${PYTORCH_ENABLE_MPS_FALLBACK:-1}"
export MORA_PYTHON="${MORA_PYTHON:-${VENV_DIR}/bin/python}"
export MORA_ML_DAEMON_SCRIPT="${MORA_ML_DAEMON_SCRIPT:-${MORA_ROOT}/Generator/python/mora_ml_daemon.py}"
export MORA_CREDENTIAL_FILE="${MORA_CREDENTIAL_FILE:-${MORA_ROOT}/Generator/.mora-worker.json}"
export MORA_ARTIFACT_PUBLIC_KEY_FILE="${MORA_ARTIFACT_PUBLIC_KEY_FILE:-${MORA_ROOT}/Generator/artifact-public.pem}"
export PATH="${VENV_DIR}/bin:${PATH}"

cd "${MORA_ROOT}"
exec node "${MORA_ROOT}/dist/Generator/src/worker-cli.js"
