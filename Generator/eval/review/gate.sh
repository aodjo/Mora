#!/bin/bash
# 소리 없는 못 문(ONSET)만 따로 잰다. 급한 못(RUSH)은 켠 채.
set -u
cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.local/bin:$PATH"
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
export MORA_DB=review-mac.db MORA_HEARD=1 MORA_RUSH=2.5
for one in "$@"; do
  echo "############ 소리 없는 못 문 ${one}ms ############"
  MORA_ONSET_MS="$one" ./.venv/bin/python -u probe_blind.py 13 2>&1 | grep --line-buffered -v "^Loading\|^Warning\|Fetching"
done
echo "=== 끝남 ==="
