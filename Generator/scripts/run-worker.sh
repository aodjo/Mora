#!/usr/bin/env bash
# 워커를 띄우고 지키고, 새 판이 나오면 갈아탄다.
#
# 손으로 세운 워커는 고친 코드를 모른다. 오늘만 네 대의 기계에 저장소를 받고 빌드하고 띄웠는데,
# 그 뒤로 언어 판정 버그를 두 번 고쳤고 네 대 모두 옛 코드로 돌고 있었다. 사람이 기억해서
# 다시 띄우는 일은 대수가 늘면 반드시 빠진다.
#
# 작업 중에 갈아타지 않는다. worker.stop() 은 ML 데몬을 곧바로 닫으므로 곡을 잡고 있는 동안
# 끊으면 그 곡을 잃는다. 워커가 남기는 .mora-worker.busy 를 읽어 한가할 때만 바꾼다.
#
#   Generator/scripts/run-worker.sh [워커번호]
#
# MORA_NO_UPDATE=1 이면 갱신 없이 지키기만 한다.
set -u

HERE="$(cd "$(dirname "$0")/../.." && pwd)"
INDEX="${1:-0}"
BRANCH="${MORA_BRANCH:-main}"
LOGS="$HERE/Generator/logs"
LOG="$LOGS/worker-$INDEX.log"
BUSY="$HERE/Generator/.mora-worker-$INDEX.busy"
# 얼마나 자주 새 판을 물을지. 잦게 물어도 얻는 것이 없고 GitHub 에 폐가 된다.
CHECK_EVERY="${MORA_CHECK_EVERY:-300}"

mkdir -p "$LOGS"
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

fresh() {
  git -C "$HERE" fetch -q origin "$BRANCH" 2>/dev/null || return 1
  [ "$(git -C "$HERE" rev-parse HEAD)" != "$(git -C "$HERE" rev-parse "origin/$BRANCH")" ]
}

update() {
  say "새 판이 있다 — 갈아탄다"
  git -C "$HERE" pull -q --ff-only origin "$BRANCH" || { say "  pull 실패 — 그대로 간다"; return 1; }
  # 파이썬 쪽이 바뀌었으면 의존도 다시 맞춘다. 대개는 안 바뀌므로 값이 거의 들지 않는다.
  if ! git -C "$HERE" diff --quiet "HEAD@{1}" HEAD -- Generator/python/pyproject.toml 2>/dev/null; then
    say "  파이썬 의존이 바뀌었다"
    "$HERE/Generator/.venv/bin/pip" install -q "$HERE/Generator/python[cuda]" >>"$LOG" 2>&1
  fi
  ( cd "$HERE" && CI=true corepack pnpm install --frozen-lockfile >>"$LOG" 2>&1 && CI=true corepack pnpm build:services >>"$LOG" 2>&1 ) \
    || { say "  빌드 실패 — 옛 판으로 계속한다"; return 1; }
  say "  $(git -C "$HERE" log --oneline -1)"
}

while true; do
  say "워커 $INDEX 시작 · $(git -C "$HERE" log --oneline -1)"
  rm -f "$BUSY"
  MORA_BUSY_FILE="$BUSY" MORA_WORKER_NAME="${MORA_WORKER_NAME:-$(hostname)-$INDEX}" \
    node "$HERE/dist/Generator/src/worker-cli.js" >>"$LOG" 2>&1 &
  WORKER=$!

  while kill -0 "$WORKER" 2>/dev/null; do
    sleep "$CHECK_EVERY"
    kill -0 "$WORKER" 2>/dev/null || break
    [ "${MORA_NO_UPDATE:-0}" = "1" ] && continue
    fresh || continue
    # 곡을 잡고 있으면 끝날 때까지 기다린다. 한 곡이 아무리 길어도 몇 분이다.
    while [ "$(cat "$BUSY" 2>/dev/null)" = "busy" ]; do
      say "  갈아탈 판이 있으나 곡을 잡고 있다 — 기다린다"
      sleep 30
    done
    say "  워커를 멈춘다"
    kill -TERM "$WORKER" 2>/dev/null
    # 스스로 안 나가면 억지로. 한가한 상태였으므로 잃을 것은 없다.
    for _ in $(seq 1 20); do kill -0 "$WORKER" 2>/dev/null || break; sleep 1; done
    kill -KILL "$WORKER" 2>/dev/null
    wait "$WORKER" 2>/dev/null
    update
    break
  done

  wait "$WORKER" 2>/dev/null
  say "워커 $INDEX 가 멈췄다 — 5초 뒤 다시 띄운다"
  sleep 5
done
