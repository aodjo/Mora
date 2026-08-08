#!/usr/bin/env bash
# Deploy to Cloudflare when the Admin console changed since the last deploy.
#
# Wired to the Stop hook, so it runs once per turn rather than once per edit —
# a deploy per Edit would publish half-finished UI to the live domain several
# times a minute. Publishing is gated on `pnpm check`: this ships to production
# without a human in the loop, so it must not ship a build that does not compile.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 0

MARKER=".git/mora-admin-deployed"
LOG=".git/mora-deploy.log"

# Everything vite bundles into the console. A change here is a change to the
# admin page; a change anywhere else is not this hook's business.
fingerprint() {
  find Admin/src Admin/index.html Admin/vite.config.ts Admin/package.json \
    -type f -exec shasum {} + 2>/dev/null | sort | shasum | cut -d' ' -f1
}

current="$(fingerprint)"
[ -z "$current" ] && exit 0

if [ "${1:-}" = "--status" ]; then
  printf 'fingerprint: %s\n' "$current"
  printf 'last deployed: %s\n' "$([ -f "$MARKER" ] && cat "$MARKER" || echo '(none)')"
  [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$current" ] && echo "verdict: unchanged, would skip" || echo "verdict: changed, would deploy"
  exit 0
fi

if [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$current" ]; then
  exit 0
fi

{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') admin changed, deploying ==="
  corepack pnpm check && corepack pnpm build && corepack pnpm worker:deploy
} >>"$LOG" 2>&1
status=$?

if [ $status -eq 0 ]; then
  printf '%s\n' "$current" >"$MARKER"
  printf '{"systemMessage":"Admin 변경 감지 → Cloudflare 배포 완료 (https://mora.junx.dev)"}\n'
  exit 0
fi

# Exit 2 wakes the model via asyncRewake so the failure is not discovered later.
printf 'Cloudflare 자동 배포 실패. 마지막 로그:\n%s\n' "$(tail -n 25 "$LOG")"
exit 2
