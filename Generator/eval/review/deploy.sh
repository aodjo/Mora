#!/usr/bin/env bash
# 맥에서 한 줄로 배포한다.  ./deploy.sh
#
# 손으로 하다 같은 자리에서 세 번 넘어졌다.
#
#   * 파일 하나를 빠뜨리고 빌드해 「없는 프롭」으로 깨졌다.
#   * `dist` 가 옛것인데 HTTP 200 만 보고 「올라갔다」고 여겼다. 서버가 살아 있어도 화면은
#     그대로다 — 그래서 **소스 해시를 번들에 심고** 그것을 찾아 확인한다. 화면 글자를 찾던
#     앞판은 그 글자가 옛 번들에도 있어 옛것을 새것으로 착각했다.
#   * `pkill -f "server[.]py"` 가 제 셸을 죽였다. 원격 명령줄에 `server.py` 가 들어 있어서다.
#     그래서 죽이기와 띄우기를 **다른 ssh 로** 가른다.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
# 기본은 mora-gpu 다 — vast.ai 에서 빌린 RTX 5090(한국). msi(RTX 3060)와 갤북(Intel Arc)에도
# 올릴 수 있다: `./deploy.sh msi` · `./deploy.sh galbook`.
# 사용자까지 적는다. 빌린 기계는 컨테이너라 `root` 뿐인데, 안 적으면 ssh 가 이쪽 사용자
# 이름으로 붙으려 해 `tailnet policy does not permit you to SSH as user "aodjo"` 로 막힌다.
HOST=${1:-root@mora-gpu}
# 기계마다 파이썬과 node 가 있는 자리가 다르다. 비대화형 ssh 는 프로필을 안 읽으므로 여기서
# 셋을 다 넣어 준다 — 없는 자리는 그냥 무시된다.
REMOTE_PATH='export PATH="/opt/conda/bin:$HOME/.local/bin:$HOME/.local/node/bin:$PATH";'
# 새 판인지 어떻게 아는가.
#
# 처음엔 「모델로 맞추기」 같은 화면 글자를 찾았는데, 그 글자는 옛 번들에도 있어서 **옛것을
# 새것으로 착각**했다. 소스의 해시를 번들에 심어 두고 그것을 찾는다 — 소스가 바뀌면 반드시
# 달라지고, 안 바뀌면 다시 지을 이유도 없다.
# 앞선 도장을 먼저 걷는다. 안 그러면 도장이 소스를 바꿔 해시가 매번 달라진다.
# 앞선 도장을 걷는다. 주석은 빌드가 지워 버리므로 **사용자 정의 속성**으로 찍는다 —
# 그것은 값이라 살아남는다.
/usr/bin/sed -i '' -e '/^\.build-[0-9a-f]\{8\} { color: red; }$/d' "$HERE"/ui/src/index.css 2>/dev/null \
  || sed -i -e '/^\.build-[0-9a-f]\{8\} { color: red; }$/d' "$HERE"/ui/src/index.css
STAMP=$(cat "$HERE"/ui/src/*.ts "$HERE"/ui/src/*.tsx "$HERE"/ui/src/*.css \
        | { md5 -q 2>/dev/null || md5sum | cut -d" " -f1; })
STAMP=${STAMP:0:8}

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# 소스 해시를 심는다. 아무도 안 쓰는 규칙이지만 이름이 남아 번들에서 찾을 수 있다.
printf '.build-%s { color: red; }\n' "$STAMP" >> "$HERE"/ui/src/index.css

say "1/4  올리기"
# `scp` 를 안 쓴다. Tailscale SSH 의 sftp 가 **간헐적으로 끊긴다** — 같은 명령이 한 번은
# 되고 한 번은 `Connection closed` 였다. 파이프로 보내면 그냥 exec 이라 그 문제가 없다.
#
# `COPYFILE_DISABLE` 는 맥의 tar 가 확장 속성을 끼워 넣는 것을 막는다. 안 막으면 받는 쪽이
# `Ignoring unknown extended header keyword` 를 줄줄이 뱉는다.
COPYFILE_DISABLE=1 tar cf - -C "$HERE" server.py align.py \
  | ssh "$HOST" 'cd ~/mora-review && tar xf -' || exit 1
COPYFILE_DISABLE=1 tar cf - -C "$HERE"/ui/src . \
  | ssh "$HOST" 'mkdir -p ~/mora-review/ui/src && cd ~/mora-review/ui/src && tar xf -' || exit 1
echo "  올림"

say "2/4  짓기"
# **빌드 전에 dist 를 지우면 안 된다.** 빌드가 깨지는 순간 화면이 통째로 사라져 서버가
# 503 을 낸다 — 고치는 동안 도구를 못 쓰게 된다. 새로 지어 놓고 **성공했을 때만** 바꿔 끼운다.
ssh "$HOST" "$REMOTE_PATH"' cd ~/mora-review/ui && rm -rf dist.new \
  && npx vite build --outDir dist.new --emptyOutDir 2>&1 | tail -3 \
  && rm -rf dist && mv dist.new dist' || {
  echo "  ✗ 짓기 실패 — 이전 화면을 그대로 둔다"; exit 1; }

say "3/4  새 판인지 확인"
if ssh "$HOST" "grep -l 'build-$STAMP' ~/mora-review/ui/dist/assets/*.css >/dev/null 2>&1"; then
  echo "  번들에 이번 소스의 자국($STAMP) 있음"
else
  echo "  ✗ 번들이 옛것이다 — 여기서 멈춘다"; exit 1
fi

say "4/4  다시 띄우기"
# 죽이기와 띄우기를 갈라야 한다. 한 셸에서 하면 pkill 이 그 셸을 잡는다.
#
# 찾는 말은 `server[.]py` 다. `python server` 로 찾다가 **조용히 실패했다** — 기계마다
# 실행 이름이 `python`·`python3`·`.venv/bin/python` 으로 달라 그 말이 안 들어 있는 일이 있다.
# 옛 서버가 그대로 살아서 새 코드가 안 물렸는데, HTTP 200 이라 겉으로는 멀쩡해 보였다.
# 대괄호는 이 명령줄 자신이 안 걸리게 하는 것이다 — 그것 없이는 제 셸을 죽인다.
ssh "$HOST" 'for p in $(pgrep -f "server[.]py"); do kill "$p" 2>/dev/null; done' || true
sleep 2
# venv 가 있으면 그것을, 없으면 PATH 의 python 을 쓴다. 기계마다 세운 방식이 다르다.
ssh "$HOST" "$REMOTE_PATH"' cd ~/mora-review && PY=$([ -x .venv/bin/python ] && echo .venv/bin/python || command -v python3 || command -v python) && setsid nohup env PATH="$PATH" "$PY" server.py > server.log 2>&1 < /dev/null &' || true
sleep 4
code=$(ssh "$HOST" 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/')
if [ "$code" != "200" ]; then
  echo "  ✗ HTTP $code"; ssh "$HOST" 'tail -20 ~/mora-review/server.log'; exit 1
fi

# **200 만으로는 못 믿는다.** 죽이기가 실패해 옛 서버가 그대로 살아 있어도 200 이 나온다 —
# 실제로 그렇게 당했다. 서버가 뜬 때가 코드를 고친 때보다 **뒤인지** 본다.
fresh=$(ssh "$HOST" '
  pid=$(pgrep -f "server[.]py" | tail -1)
  [ -n "$pid" ] || { echo no-pid; exit; }
  up=$(date -d "$(ps -o lstart= -p "$pid")" +%s 2>/dev/null) || { echo no-date; exit; }
  code=$(stat -c %Y ~/mora-review/align.py 2>/dev/null || echo 0)
  [ "$up" -ge "$code" ] && echo fresh || echo stale')
case "$fresh" in
  fresh) echo "  떴다 · 새 코드로 · http://${HOST#*@}.tail277268.ts.net:8787" ;;
  stale) echo "  ✗ 옛 서버가 그대로 살아 있다 — 죽이기가 실패했다"; exit 1 ;;
  *)     echo "  떴다 (서버 뜬 때를 못 읽음: $fresh) · http://${HOST#*@}.tail277268.ts.net:8787" ;;
esac
