#!/bin/bash
# 급한 못 버리기(RUSH)를 켠 것과 끈 것을 쌩 가사로 견준다. 소리 없는 못 버리기(ONSET)는 둘 다 켠다.
set -u
cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.local/bin:$PATH"
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
export MORA_DB=review-mac.db MORA_HEARD=1 MORA_ONSET_MS=400
for one in "$@"; do
  echo "############ 급한 못 잣대 ${one} ############"
  MORA_RUSH="$one" ./.venv/bin/python -u probe_blind.py 13 2>&1 | grep --line-buffered -v "^Loading\|^Warning\|Fetching"
done
echo "=== 끝남 ==="
