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
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=ts-build /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY Generator/python ./Generator/python
RUN pip install --no-cache-dir "./Generator/python[cuda]"
COPY --from=ts-build /app/dist ./dist
CMD ["node", "dist/Generator/src/worker-cli.js"]
