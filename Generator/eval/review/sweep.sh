#!/bin/bash
# 되돌림 기준을 훑는다. 인자로 준 값마다 쌩 가사 한 판.
#
# 긴 명령줄로 돌리면 그 명령줄 안에 `probe_blind` 라는 글자가 들어가고, 기다림이나 멈춤에 쓰는
# `pgrep -f` · `pkill -f` 가 **자기 자신을 잡는다**. 실제로 그 탓에 46 분을 헛돌았고 ssh 가 제
# 손에 끊기기도 했다. 파일로 두면 명령줄에는 파일 이름만 남는다.
#
# 쓰기: ./sweep.sh 400 500

set -u
cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.local/bin:$PATH"
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
export MORA_DB="${MORA_DB:-review-mac.db}"
export MORA_HEARD=1

for one in "$@"; do
  echo "############ 되돌림 기준 ${one}ms ############"
  MORA_OURS_APART="$one" ./.venv/bin/python -u probe_blind.py 13 2>&1 \
    | grep -E "쌩 가사:|Traceback|Error"
done
echo "=== 끝남 ==="
