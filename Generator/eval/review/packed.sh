#!/bin/bash
# 빽빽함 문턱을 훑는다. 「소리 50ms」 가 이 오차를 볼 수 있는 자다 — 줄을 고르게 펴면 낱자가
# 소리 솟는 자리에서 멀어지므로 그 칸이 떨어진다. 「제자리」는 줄 시작만 보므로 못 본다.
set -u
cd "$(dirname "$0")" || exit 1
export MORA_DB="${MORA_DB:-review.db}"
for one in "$@"; do
  echo "############ 빽빽함 문턱 ${one}ms ############"
  MORA_PACKED_MS="$one" ./.venv/bin/python -u probe_blind.py 13 2>&1 \
    | grep --line-buffered -v "^Loading\|^Warning\|Fetching"
done
echo "=== 끝남 ==="
