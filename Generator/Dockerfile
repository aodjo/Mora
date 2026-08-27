FROM node:24-bookworm-slim AS ts-build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY Generator ./Generator
COPY Collector ./Collector
COPY Server ./Server
# test 는 넣지 않는다. 그 안의 세 파일이 Admin/src 를 import 하는데 Admin 은 이 이미지에
# 들어오지 않아, 타입이 풀리지 않고 build:services 가 통째로 깨진다.
RUN corepack pnpm install --frozen-lockfile && corepack pnpm build:services

FROM pytorch/pytorch:2.7.1-cuda12.8-cudnn9-runtime
ARG TARGETARCH
ARG NODE_VERSION=24.20.0
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1
# build-essential 은 두고 간다. demucs 가 끌어오는 diffq 가 C 확장을 그 자리에서 컴파일하는데
# 이 이미지에는 gcc 가 없어 pip install 이 통째로 죽었다. 지운 뒤 무엇이 그것을 필요로 하는지
# 확실치 않아 남긴다 — 7 GB 짜리 이미지에서 200 MB 는 그만한 값이 아니다.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl xz-utils build-essential python3-dev \
 && rm -rf /var/lib/apt/lists/*

# 노드는 받아서 넣는다. 앞선 판은 ts-build 층의 /usr/local/bin/node 를 복사했는데, 그쪽은
# bookworm(glibc 2.36) 이고 이 이미지는 jammy(glibc 2.35) 다 — 실행하는 순간에야 드러나는
# 어긋남이다.
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) arch=x64 ;; \
      arm64) arch=arm64 ;; \
      *) echo "노드가 지원하지 않는 아키텍처: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 --no-same-owner; \
    node --version

WORKDIR /app
COPY Generator/python ./Generator/python
# 평가 도구도 함께 넣는다. 기계마다 scp 로 밀어 넣던 것인데, 이미지에 있으면 그 단계가 없어지고
# 이미지와 도구의 판이 어긋날 일도 없다.
COPY Generator/eval ./Generator/eval
RUN pip install --no-cache-dir "./Generator/python[cuda]"
COPY --from=ts-build /app/dist ./dist
CMD ["node", "dist/Generator/src/worker-cli.js"]
