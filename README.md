# Mora

Mora는 클라이언트가 이미 가진 가사에 단어·줄·익명 발화자 타이밍을 얹는 시스템입니다. 공개 Server와 덤프에는 가사 문자가 없고 숫자 지문과 활성 타이밍만 들어갑니다.

```text
Collector → Admin Control Plane → Queue → Generator
                ↑                         │
                └──── 후보·스템·상태 ─────┘
                │
                └──── 승인/품질 게이트 → Public Server
```

## 앱 구성

- `Admin/`: React + Vite + TailwindCSS Control Plane. 작업, 워커, 검수, 타이밍 편집, 권한, 감사 로그를 관리합니다.
- `Collector/`: KR/US/JP 인기곡·신곡을 찾고 MusicBrainz로 ISRC를 보강하며, 내장 SongTitle 라우터의 모든 provider 원문과 YouTube Music 오디오 후보를 제출합니다.
- `Generator/`: Cloudflare Queue pull consumer. `yt-dlp`, `htdemucs_ft`, Whisper large-v3-turbo, forced alignment, diarization과 speaker stem 생성을 실행합니다.
- `Server/`: Cloudflare Worker. Admin API/asset과 가사 없는 Public API를 함께 서빙합니다.
- `packages/`: API 계약, 전처리, 토큰화, 지문, 정렬, 포맷 변환과 `songtitle` 가사 provider 라우터를 공유합니다.

## 데이터 경계

| 저장소 | 내용 |
|---|---|
| `PUBLIC_DB` | 활성 recording, 지문, 줄/단어 timing, 익명 speaker index |
| `ADMIN_DB` | 원문·전처리 가사 리비전, 작업, 후보, provenance, RBAC, 감사 로그 |
| `ADMIN_ARTIFACTS` | 원본과 모든 stem의 파일별 청크 암호문 |
| 주간 SQLite 덤프 | `PUBLIC_DB` 활성본만 |

Generator는 파일별 256-bit 데이터 키로 4 MiB AES-GCM 청크를 만들고 RSA-OAEP 관리 키로 데이터 키를 감쌉니다. Admin Worker는 권한 검사 후 필요한 청크만 복호화해 HTTP Range로 스트리밍합니다. 비밀값과 서비스 키는 발급/교체할 수 있지만 다시 조회할 수 없습니다.

## 개발 환경

Node.js 24, pnpm 11, Python 3.11~3.13, ffmpeg가 필요합니다.

```bash
corepack pnpm install
cp Server/.dev.vars.example Server/.dev.vars
corepack pnpm d1:migrate:local
corepack pnpm build
corepack pnpm dev:worker
```

Dashboard는 `http://localhost:8787/admin/`입니다. 첫 접속에서는 `.dev.vars`의 `BOOTSTRAP_TOKEN`으로 최초 관리자 패스키를 등록합니다.

검증 명령:

```bash
corepack pnpm check
corepack pnpm test
corepack pnpm worker:build
python3 -m py_compile Generator/python/mora_ml_daemon.py
```

## Cloudflare 배포 준비

```bash
corepack pnpm infra:login
corepack pnpm infra:provision
```

프로비저닝 명령은 다음 작업을 멱등적으로 수행합니다.

- APAC D1 `mora-public`, `mora-admin` 생성 및 실제 ID 바인딩
- R2 `mora-admin-artifacts`, `mora-public-dumps` 생성
- `mora-generation` Queue와 HTTP pull consumer 생성
- 원격 D1 migration, Admin/Worker 빌드 및 배포
- Bootstrap token, 설정 암호화 키, artifact RSA 키 생성 및 Cloudflare Secret 등록
- 빈 카탈로그를 포함한 최초 공개 SQLite dump 게시

최초 관리자 등록에 필요한 값은 권한 `0600`의 `Server/.mora-infra-secrets.json`에 한 번 생성됩니다. 이 파일을 암호 관리자로 옮긴 뒤 로컬 사본의 보관 여부를 결정하세요. Generator용 공개 키는 `Generator/artifact-public.pem`에 생성됩니다. 두 파일은 Git에서 제외됩니다.

배포 후 Cloudflare에서 Account/Queues Edit 권한의 전용 API token을 만들고 Queue ID와 함께 Generator에 제공합니다. YouTube 쿠키, Hugging Face token, Cloudflare token은 Queue 메시지·작업 JSON·로그에 넣지 않습니다.

### Dashboard 환경 설정

Admin의 `권한·설정 → 서버 런타임 환경`에서 외부 dump URL, WebAuthn RP/origin, 자동 승격과 품질 임계치, Webhook timeout·서명키를 관리합니다. 일반 값은 즉시 반영되고 비밀값은 암호화된 write-only 값으로 저장됩니다. D1/R2/Queue binding과 `BOOTSTRAP_TOKEN`, `SECRET_ENCRYPTION_KEY`, `ARTIFACT_PRIVATE_KEY`는 Worker 부팅과 복호화의 신뢰 루트이므로 Dashboard에서는 상태만 표시하며 Cloudflare 배포 도구로만 교체합니다.

## Generator 실행

Apple Silicon:

```bash
cd Generator/python
uv sync --extra apple
cd ../..
corepack pnpm build:services

MORA_PYTHON=Generator/python/.venv/bin/python \
MORA_ADMIN_URL=https://mora.example \
MORA_GENERATOR_TOKEN=mora_... \
MORA_WORKER_ID=... \
MORA_ARTIFACT_PUBLIC_KEY="$(cat artifact-public.pem)" \
CF_ACCOUNT_ID=... CF_QUEUE_ID=... CF_API_TOKEN=... \
YTDLP_COOKIE_FILE=/secure/path/cookies.txt \
node dist/Generator/src/worker-cli.js
```

새 워커는 Admin에서 일회용 등록 token을 만든 뒤 `MORA_ENROLLMENT_TOKEN`으로 한 번 실행합니다. 자격증명은 `.mora-worker.json`에 mode `0600`으로 기록됩니다. self-test에서 GPU backend, yt-dlp, ffmpeg, Demucs, ASR, aligner를 모두 통과한 워커만 production 작업을 받습니다. diarization은 best-effort입니다.

Linux CUDA용 `Generator/Dockerfile`도 제공됩니다. XPU/ROCm은 같은 backend adapter와 self-test 계약을 사용하며, 해당 PyTorch 런타임 이미지에서 실행합니다.

## Collector 연결

`~/Documents/SongTitle`의 소스는 `packages/songtitle` 워크스페이스 패키지로 포함되어 있습니다. Collector는 별도 adapter 설정 없이 Melon, Bugs, Genie, FLO, Vibe, Genius, LyricFind, Shazam에서 성공한 원문을 모두 Admin에 제출합니다.

```bash
MORA_ADMIN_URL=https://mora.example \
MORA_COLLECTOR_TOKEN=mora_... \
COLLECTOR_DAILY_BUDGET=300 \
corepack pnpm dev:collector
```

`SONGTITLE_PROVIDERS=melon,bugs,genie`, `SONGTITLE_TIMEOUT_MS=12000`으로 범위와 타임아웃을 조절합니다. `SONGTITLE_BROWSER=1`은 Chromium 폴백을 켜고 `SONGTITLE_HEADFUL=1`은 디버깅용 창을 표시합니다. Genius API와 LyricFind는 각각 `GENIUS_ACCESS_TOKEN`, `LYRICFIND_API_KEY`를 사용합니다. 브라우저를 쓰려면 한 번 `corepack pnpm --filter @mora/songtitle exec playwright install chromium`을 실행합니다.

다른 라이브러리를 쓰려면 `packages/contracts`의 `LyricsProvider`를 default 또는 `provider`로 export하고 `LYRICS_LIBRARY_MODULE=/absolute/path/to/provider.js`를 지정하면 내장 SongTitle 대신 사용됩니다.

Collector는 뮤직비디오·live·cover·karaoke·instrumental·sped-up 결과를 자동 후보에서 제외합니다. 공식/Topic 오디오이면서 점수 0.90 이상인 경우에만 자동 선택합니다. ISRC나 소스가 모호하면 Generator 작업을 만들지 않고 Admin 검수함으로 보냅니다.

## Public API

`POST /v1/align`은 ISRC, MBID 또는 `artist + title + duration_ms`와 클라이언트 가사를 받습니다. 메타데이터 조회가 모호하면 409를 반환합니다.

```json
{
  "isrc": "KRA382400123",
  "text": "클라이언트가 이미 가진 가사",
  "duration_ms": 214000,
  "language": "ko"
}
```

응답 tier는 `word ≥ .90`, `word-approx ≥ .60`, `line ≥ .30`, 그 미만 `none`입니다. `spans`의 마지막 숫자는 실제 정렬 `0`, 글자 수 비례 보간 `1`입니다. 응답에는 원문, provider, YouTube ID, 모델명, 과거 리비전이 없습니다.

그 밖에 `/v1/align/fingerprint`, `/v1/tokenize`, `/v1/dump`와 `?format=spans|lrc-a2|lyricsfile|ttml|webvtt`를 지원합니다.

## 운영 정책

- 초기 100개 승인 결과는 사람이 교정합니다. 100번째 승인 후 품질 threshold를 통과한 후보의 자동 승격이 활성화됩니다.
- 복구 가능한 작업은 최대 3번 재시도하며 고비용 산출물은 R2 체크포인트로 재사용합니다.
- 수정은 새 입력/후보/공개 리비전으로만 이루어지며 공개본은 철회·롤백할 수 있습니다.
- 감사 로그는 무기한, request body가 없는 진단 로그는 30일 정책입니다.
- 범용 Webhook과 Discord Webhook을 지원합니다. URL은 암호화된 write-only secret입니다.
- `corepack pnpm dump:publish`는 활성 공개 데이터만 SQLite로 만들어 R2에 업로드합니다. GitHub Actions 주간 workflow도 포함됩니다.

원본과 stem의 장기 보관 및 `yt-dlp` 사용은 운영자가 권리와 이용약관을 별도로 검토해야 합니다.
