#!/usr/bin/env bash
# DGX Spark 를 Mora Generator 워커로 띄운다. run-worker.sh 가 지키고, main 이 바뀌면 한가할 때 갈아탄다.
#   tmux new -d -s mora-gen 'bash ~/mora-gen/Mora/Generator/scripts/spark/start-worker.sh'   · 로그: ~/mora-gen/Mora/Generator/logs/worker-0.log
# 처음 한 번은 ~/mora-gen/enroll_token(POST /admin/api/workers/enrollment 로 받는 한 번 쓰는 토큰, mode 600)으로 제 키를 받아 Generator/.mora-worker.json 에 둔다.
set -u
ROOT=$HOME/mora-gen
cd "$ROOT/Mora"
export PATH="$ROOT/node/bin:$ROOT/Mora/Generator/.venv/bin:$HOME/.local/bin:$PATH"
export MORA_ADMIN_URL=https://mora.junx.dev MORA_WORKER_NAME=spark
# 노래 정렬기와 도우미 살림 — build-aligner-envs.sh 가 세운 것.
ENVS=${MORA_SPARK_ENVS:-$HOME/mora-val2/env}
export MORA_REVIEW_PYTHON=$ENVS/aligner/bin/python
export MORA_QWEN_PYTHON=$ENVS/qwen/bin/python
export MORA_DIA_PYTHON=$ENVS/dia/bin/python
export MORA_EARS_PYTHON=$HOME/ears/bin/python
export MORA_MODEL_DIR=$ROOT/models MORA_WORK_ROOT=$ROOT/work MORA_CACHE_ROOT=$ROOT/cache
# 코어 8 개에 torch 여럿이 저마다 스레드를 다 잡으면 서로 밀친다.
export OMP_NUM_THREADS=4 MKL_NUM_THREADS=4
mkdir -p "$ROOT/models" "$ROOT/work" "$ROOT/cache"
if [ ! -f Generator/.mora-worker.json ] && [ -f "$ROOT/enroll_token" ]; then
  MORA_ENROLL_TOKEN="$(cat "$ROOT/enroll_token")"
  export MORA_ENROLL_TOKEN
fi
exec Generator/scripts/run-worker.sh 0
