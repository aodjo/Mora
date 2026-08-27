# Generator

Mora Generator는 Admin Worker의 D1 작업 큐를 승인된 서비스 키로 소비합니다. 주 실행 대상은 Apple Silicon Mac이며 MPS와 MLX를 호스트에서 직접 사용합니다. Linux NVIDIA GPU용 Dockerfile은 보조 배포 경로입니다.

Python daemon은 stdout JSON-RPC만 사용하고 모델을 프로세스에 유지합니다. TypeScript orchestrator가 Queue lease, Admin API, `unilab-v2`, 아티팩트 암호화와 재시도를 담당합니다.

주요 파일:

- `src/worker-cli.ts`: 등록 또는 production worker 진입점
- `src/worker.ts`: 한 곡씩 처리하는 orchestration
- `src/cloudflare-queue.ts`: pull/ack/retry
- `src/admin-client.ts`: 후보·이벤트·암호화 아티팩트 제출
- `python/mora_ml_daemon.py`: yt-dlp/ffmpeg/Demucs/ASR/alignment/diarization

`src/cli.ts`의 HTTP builder는 이전 v0.1 fixture 호환용이며 production 경로가 아닙니다.

## Apple Silicon Mac

Docker Desktop의 Linux VM에는 Metal/MPS GPU가 전달되지 않으므로 Mac에서는 네이티브 프로세스로 실행합니다.

```bash
Generator/scripts/setup-macos.sh
```

Mora Admin 또는 Cloudflare 인증 토큰은 직접 입력하지 않습니다. 다른 Admin 주소, YouTube 쿠키, Hugging Face token, 캐시·작업 경로 같은 선택 설정만 필요할 때 `Generator/.env.example`을 복사해 사용합니다.
Admin 주소의 기본값은 `https://mora.junx.dev`이며 다른 환경에서만 `MORA_ADMIN_URL`로 덮어씁니다.

```bash
Generator/scripts/self-test-macos.sh
npm run generator
```

외부 음원 없이 macOS 합성 음성으로 다운로드부터 정렬까지 확인하는 스모크 테스트:

```bash
node Generator/scripts/smoke-test-macos.mjs
```

첫 실행은 환경 self-test를 통과한 뒤 10자리 PIN을 표시합니다. `Admin → 기기 연결 → Generator 연결`에서 승인하면 API key와 worker ID를 `Generator/.mora-worker.json`에 mode `0600`으로 저장하고 작업 소비를 시작합니다. 이후 실행은 이 파일을 자동으로 재사용합니다.

로그인 후에도 계속 실행하려면 LaunchAgent를 설치합니다.

```bash
Generator/scripts/install-launch-agent.sh
tail -f Generator/.logs/generator.log Generator/.logs/generator.error.log
```

중지 및 제거:

```bash
Generator/scripts/uninstall-launch-agent.sh
```

## 컨테이너로 받아 쓰기

빌린 기계마다 저장소를 받고 apt 를 깔고 torch·whisperx·demucs 를 pip 로 세울 필요 없이, 지어 둔 것을 받아 씁니다.

```bash
docker run --rm --gpus all \
  -e MORA_ADMIN_URL=https://mora.junx.dev \
  -v mora-generator:/data \
  ghcr.io/aodjo/mora-generator:latest
```

첫 실행은 PIN 을 띄웁니다. `Admin → 권한·설정 → Generator 연결`에 넣으면 서비스 키를 받아 `/data` 볼륨에 저장하고, 이후 실행은 자동입니다.

이미지는 태그를 붙이거나 릴리스를 낼 때, 또는 Actions 에서 손으로 돌릴 때 지어집니다 (`.github/workflows/generator-image.yml`). GPU 가 필요하므로 `--gpus all` 과 호스트의 NVIDIA Container Toolkit 이 있어야 합니다.
