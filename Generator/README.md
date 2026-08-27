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

## 기계를 고를 때 — 실측 (2026-08-27)

빌린 기계를 네 번 갈아타면서 잰 것이다. 매번 짐작으로 골랐고 매번 틀렸으므로 적어 둔다.

**VRAM 이 동시판수를 정한다.** whisper large-v3 한 벌이 GPU 를 10 GB 쯤 쓴다. 16 GB 짜리에
두 판을 올렸다가 `CUDA failed with error out of memory` 로 죽었고, 25 GB 에서는 두 판이 선다.
곡당 값으로 치면 16 GB $0.12 짜리보다 25 GB $0.20 짜리가 싸다.

**코어 수는 거의 상관없다.** demucs 를 스레드 4·8·16·31·64·128 로 돌려 보니 전부 29 초로
같았다. 이 파이프라인은 CPU 에 묶여 있지 않다.

`nproc` 를 믿으면 안 된다. 빌린 기계는 128 코어를 보여 주면서 cgroup 할당량은 31 코어인 일이
흔하다(`/sys/fs/cgroup/cpu.max`). PyTorch 는 nproc 를 읽어 128 개 스레드를 띄우고, 그것들이
서로 밟는다. A100 두 장짜리에서 CPU 가 93.9% 로 보이고 GPU 는 0% 였던 것이 이 때문이다 —
그 기계는 곡당 390~650 초였고, 그보다 훨씬 싼 A4000 한 장이 곡당 56 초였다.

**GPU 등급은 값어치가 없다.** A100 SXM4 두 장($2.83/h)이 RTX A4000 한 장($0.15/h)보다 느렸다.
스무 배 값을 치르고 열 배 느렸다.

**지역이 중요하다.** 워커는 유튜브에서 음원을 받는다. 미국 데이터센터 IP 는 74/74 를 403 으로
막혔고, 일본·한국·태국은 그냥 된다. 아시아에서 고르는 편이 손으로 프록시를 파는 것보다 낫다.

정리하면 **VRAM 24 GB 이상, 코어 24 개 이상, 아시아, 시간당 $0.20 안팎**이 지금까지의 답이다.
GPU 개수와 등급은 보지 않아도 된다.

## 워커를 띄우고 새 판에 따라가게 하기

```bash
Generator/scripts/run-worker.sh 0    # GPU 여러 장이면 번호를 달리해 여러 개
```

죽으면 다시 띄우고, `main` 에 새 커밋이 있으면 받아서 다시 짓고 갈아탑니다. **곡을 잡고 있는 동안에는 갈아타지 않습니다** — `worker.stop()` 이 ML 데몬을 곧바로 닫으므로 작업 중에 끊으면 그 곡을 잃습니다. 워커가 `.mora-worker-N.busy` 에 지금 상태를 적고, 스크립트는 그것이 `idle` 이 될 때까지 기다립니다.

손으로 세운 워커는 고친 코드를 모릅니다. 하루에 네 대를 세우고 그 뒤로 언어 판정 버그를 두 번 고쳤는데 네 대 모두 옛 코드로 돌고 있던 적이 있습니다. 사람이 기억해서 다시 띄우는 일은 대수가 늘면 반드시 빠집니다.

| 환경변수 | 뜻 |
|---|---|
| `MORA_BRANCH` | 따라갈 가지 (기본 `main`) |
| `MORA_CHECK_EVERY` | 새 판을 묻는 주기, 초 (기본 300) |
| `MORA_NO_UPDATE=1` | 갱신하지 않고 지키기만 |
