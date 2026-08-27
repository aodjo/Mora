#!/usr/bin/env bash
# 빈 리눅스 기계 하나를 Generator 워커로 만든다.
#
#   curl -fsSL https://raw.githubusercontent.com/aodjo/Mora/main/Generator/scripts/install.sh | bash
#
# 워커까지 곧바로 띄우려면 등록 토큰을 함께 준다. Admin → 권한·설정 → Generator 연결에서
# 받거나 POST /admin/api/workers/enrollment 로 만든다.
#
#   curl -fsSL .../install.sh | MORA_ENROLL_TOKEN=mora_… bash
#
# 지어 둔 이미지(ghcr.io/aodjo/mora-generator)를 쓰는 길도 있지만 그쪽은 9 GB 를 받는다.
# 이 길은 필요한 것만 받으므로 대개 더 빠르고, 이미 켜 둔 기계에도 쓸 수 있다.
set -euo pipefail

ROOT="${MORA_ROOT:-/workspace}"
BRANCH="${MORA_BRANCH:-main}"
REPO="${MORA_REPO:-https://github.com/aodjo/Mora.git}"
LOG="$ROOT/logs/install.log"
mkdir -p "$ROOT/logs"
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
die() { say "✖ $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "root 로 돌려야 한다 (apt 를 쓴다)"

export DEBIAN_FRONTEND=noninteractive
# 빌린 기계는 우리가 붙는 순간에도 제 설치를 돌리고 있다. dpkg 를 두고 다투면 우리 쪽이 조용히
# 실패하고, gcc 가 없는 채로 한참 뒤 diffq 에서 터진다 — 실제로 그렇게 한 대를 잃었다.
APT="apt-get -o DPkg::Lock::Timeout=900"
say "시스템 꾸러미 (다른 설치가 돌고 있으면 기다린다)"
$APT update -qq >>"$LOG" 2>&1
$APT install -y -qq --no-install-recommends \
  git curl ca-certificates ffmpeg tmux gnupg jq unzip build-essential python3-dev python3-venv >>"$LOG" 2>&1
# demucs 가 끌어오는 diffq 는 C 확장을 그 자리에서 컴파일한다. 없으면 여기서 멈춰야 한다 —
# 뒤에서 터지면 무엇이 원인인지 찾는 데 한참 걸린다.
command -v gcc >/dev/null || die "gcc 가 없다 — apt 가 실패했다. $LOG 를 볼 것"
say "  ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f3) · gcc $(gcc -dumpversion)"

if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  say "node"
  curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource.sh >>"$LOG" 2>&1
  bash /tmp/nodesource.sh >>"$LOG" 2>&1
  $APT install -y -qq nodejs >>"$LOG" 2>&1
fi
corepack enable >>"$LOG" 2>&1 || true
say "  node $(node -v)"

say "저장소"
if [ ! -d "$ROOT/Mora/.git" ]; then
  git clone -q --branch "$BRANCH" "$REPO" "$ROOT/Mora" >>"$LOG" 2>&1
fi
git -C "$ROOT/Mora" fetch -q origin "$BRANCH" >>"$LOG" 2>&1
git -C "$ROOT/Mora" checkout -q "$BRANCH" >>"$LOG" 2>&1
git -C "$ROOT/Mora" pull -q --ff-only origin "$BRANCH" >>"$LOG" 2>&1
say "  $(git -C "$ROOT/Mora" log --oneline -1)"

say "노드 의존 + 빌드"
( cd "$ROOT/Mora" && CI=true corepack pnpm install --frozen-lockfile >>"$LOG" 2>&1 \
  && CI=true corepack pnpm build:services >>"$LOG" 2>&1 ) || die "빌드가 실패했다 — $LOG"
[ -f "$ROOT/Mora/dist/Generator/src/worker-cli.js" ] || die "worker-cli 가 만들어지지 않았다"

say "파이썬 환경 (오래 걸린다 — torch·whisperx·demucs)"
VENV="$ROOT/Mora/Generator/.venv"
[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV" >>"$LOG" 2>&1
"$VENV/bin/pip" install -q --upgrade pip >>"$LOG" 2>&1
# GPU 가 보이면 cuda 판으로, 아니면 기본 판으로. 없는 것을 억지로 깔면 pip 가 통째로 죽는다.
EXTRA=""
command -v nvidia-smi >/dev/null && nvidia-smi -L >/dev/null 2>&1 && EXTRA="[cuda]"
"$VENV/bin/pip" install -q "$ROOT/Mora/Generator/python$EXTRA" >>"$LOG" 2>&1 || die "파이썬 의존 설치가 실패했다 — $LOG"
say "  $("$VENV/bin/python" -c 'import torch;print(f"torch {torch.__version__} cuda={torch.cuda.is_available()} gpu={torch.cuda.device_count()}")' 2>&1 | tail -1)"

if [ -n "${MORA_ENROLL_TOKEN:-}" ]; then
  say "워커를 띄운다"
  # run-worker.sh 가 지키고, 새 판이 나오면 한가할 때 갈아탄다.
  cd "$ROOT/Mora"
  MORA_ENROLL_TOKEN="$MORA_ENROLL_TOKEN" \
  MORA_ADMIN_URL="${MORA_ADMIN_URL:-https://mora.junx.dev}" \
  MORA_WORKER_NAME="${MORA_WORKER_NAME:-$(hostname)}" \
    setsid nohup "$ROOT/Mora/Generator/scripts/run-worker.sh" 0 >>"$ROOT/logs/worker.log" 2>&1 < /dev/null &
  sleep 3
  say "  로그: $ROOT/logs/worker.log · $ROOT/Mora/Generator/logs/worker-0.log"
else
  say "다 됐다. 워커를 띄우려면:"
  say "  cd $ROOT/Mora && MORA_ENROLL_TOKEN=… Generator/scripts/run-worker.sh 0"
fi
say "끝"
