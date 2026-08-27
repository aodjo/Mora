# syntax=docker/dockerfile:1

# Collector 를 한 벌로 묶는다.
#
# 이 그릇에 들어가야 하는 것은 넷이다. 노드로 짠 수집기 자신, 그것이 셸로 부르는 yt-dlp,
# 가사 서비스가 브라우저를 요구할 때 쓰는 Chromium, 그리고 짝지어 받은 서비스 키다.
# 앞의 셋은 이미지에 굽고 마지막 하나는 절대 굽지 않는다 — 키가 구워진 이미지는 그것을 가진
# 누구나 Admin 에 붙는다. 키는 /data 볼륨에만 있다.

# ── 빌드 ──────────────────────────────────────────────────────────────────────
# Admin 은 넣지 않는다. 워크스페이스에 이름은 있지만 Collector 가 쓰지 않고, vite 와 react 를
# 받느라 이미지만 커진다. pnpm 은 없는 워크스페이스 폴더를 그냥 지나간다.
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY Collector ./Collector
COPY Generator ./Generator
COPY Server ./Server
# test 는 넣지 않는다. 이미지가 시험을 돌리지 않기도 하지만, 그보다 test 안의 세 파일이
# Admin/src 를 import 해서 — Admin 을 안 넣으면 타입이 풀리지 않아 빌드가 통째로 깨진다.
# tsconfig 의 include 에 test 가 있어도 폴더가 없으면 tsc 는 그냥 덜 컴파일한다.
#
# CI=true 가 없으면 아래 --prod 가 "TTY 가 없어 node_modules 를 지울 수 없다"며 멈춘다.
ENV CI=true
# 짓고 나서 개발용 의존을 걷어낸다. typescript·tsx·wrangler·workerd 는 지은 뒤에는 쓰이지
# 않는데 합쳐서 수백 MB 다.
RUN corepack pnpm install --frozen-lockfile \
 && corepack pnpm build:services \
 && corepack pnpm install --prod --frozen-lockfile

# ── 실행 ──────────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim
ARG TARGETARCH
# Chromium 없이 지으려면 --build-arg WITH_BROWSER=0. 가사 서비스 중 몇은 브라우저 없이는
# 원문을 주지 않으므로 기본은 넣는 쪽이다. 빼면 이미지가 400 MB 쯤 가벼워진다.
ARG WITH_BROWSER=1
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    YTDLP_BIN=/usr/local/bin/yt-dlp \
    MORA_COLLECTOR_CREDENTIAL_FILE=/data/mora-collector.json \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp 는 배포판 것을 쓰지 않는다. 유튜브가 자주 바뀌어서 데비안에 들어 있는 판은 대개
# 이미 못 쓴다. 배포된 단일 실행 파일을 받는다 — 아키텍처마다 파일 이름이 다르다.
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) asset=yt-dlp_linux ;; \
      arm64) asset=yt-dlp_linux_aarch64 ;; \
      *) echo "yt-dlp 가 지원하지 않는 아키텍처: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/yt-dlp \
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$asset"; \
    chmod 0755 /usr/local/bin/yt-dlp; \
    /usr/local/bin/yt-dlp --version

WORKDIR /app
COPY --from=build /app /app

# Chromium 과 그것이 요구하는 시스템 라이브러리.
#
# 여기 있는 playwright 로 받는다. npx 로 따로 부르면 판이 어긋날 수 있는데, 브라우저와
# 라이브러리의 판이 맞지 않으면 실행할 때에야 알게 된다. 이 자리에서는 아직 root 라
# --with-deps 의 apt-get 이 돈다.
RUN if [ "$WITH_BROWSER" = "1" ]; then \
      ./packages/songtitle/node_modules/.bin/playwright install --with-deps chromium \
      && rm -rf /var/lib/apt/lists/* \
      && chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"; \
    else \
      echo "Chromium 없이 짓는다 — Admin 의 SongTitle 브라우저 옵션을 켜면 안 된다"; \
    fi

# 키가 놓일 자리. 이름 붙인 볼륨이 처음 만들어질 때 이 주인을 물려받는다.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]

# tini 가 없으면 yt-dlp 자식이 좀비로 남는다. 수집 한 번에 두 번씩 부르므로 금방 쌓인다.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/Collector/src/cli.js"]
