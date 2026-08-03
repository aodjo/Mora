# Mora

Mora는 클라이언트가 이미 가진 가사에 단어·줄·익명 발화자 타이밍을 얹는 시스템입니다. 공개 Server와 덤프에는 가사 문자가 없고 숫자 지문과 활성 타이밍만 들어갑니다.

```text
Collector → Admin Control Plane/D1 작업 큐 → Generator
                ↑                         │
                └──── 후보·스템·상태 ─────┘
                │
                └──── 승인/품질 게이트 → Public Server
```

## 앱 구성

- `Admin/`: React + Vite + TailwindCSS Control Plane. 작업, 워커, 검수, 타이밍 편집, 권한, 감사 로그를 관리합니다.
- `Collector/`: KR/US/JP 인기곡·신곡을 찾고 MusicBrainz로 ISRC를 보강하며, 내장 SongTitle 라우터의 모든 provider 원문과 YouTube Music 오디오 후보를 제출합니다.
- `Generator/`: 승인된 서비스 키로 Admin 작업 큐를 소비합니다. `yt-dlp`, `htdemucs_ft`, Whisper large-v3-turbo, forced alignment, diarization과 speaker stem 생성을 실행합니다.
- `Server/`: Cloudflare Worker. Admin API/asset과 가사 없는 Public API를 함께 서빙합니다.
- `packages/`: API 계약, 전처리, 토큰화, 지문, 정렬, 포맷 변환과 `songtitle` 가사 provider 라우터를 공유합니다.

Collector는 후보 목록의 순위만 먼저 계산합니다. 실제 곡 데이터는 한 곡씩 수집해 즉시 Admin 작업 큐에 넣으며, Generator는 Collector가 다음 곡을 수집하는 동안 방금 들어온 작업을 처리합니다.

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
corepack pnpm local:setup
corepack pnpm build
corepack pnpm dev:worker
```

개발 중에는 다른 터미널에서 `corepack pnpm dev:admin`을 실행하고 `http://localhost:5173/admin/`에 접속합니다. 첫 접속에서는 `.dev.vars`의 `BOOTSTRAP_TOKEN`으로 최초 관리자 패스키를 등록합니다. Worker가 `localhost:8787`에서 함께 실행 중이어야 합니다.

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
- `mora-generation` Queue binding 생성(향후 이벤트 트리거용)
- 원격 D1 migration, Admin/Worker 빌드 및 배포
- Bootstrap token, 설정 암호화 키, artifact RSA 키 생성 및 Cloudflare Secret 등록
- 빈 카탈로그를 포함한 최초 공개 SQLite dump 게시

최초 관리자 등록에 필요한 값은 권한 `0600`의 `Server/.mora-infra-secrets.json`에 한 번 생성됩니다. 이 파일을 암호 관리자로 옮긴 뒤 로컬 사본의 보관 여부를 결정하세요. Generator용 공개 키는 `Generator/artifact-public.pem`에 생성됩니다. 두 파일은 Git에서 제외됩니다.

프로덕션 Worker와 Admin의 기본 주소는 `https://mora.junx.dev`입니다. `Server/wrangler.jsonc`의 Custom Domain 설정으로 Cloudflare DNS와 TLS가 Worker에 연결됩니다. 기존 도메인에서 만든 패스키는 WebAuthn 보안 정책상 새 도메인에서 사용할 수 없으므로, 로그인 화면의 `이 도메인에 패스키 추가`에서 기존 관리자 이메일과 `Server/.mora-infra-secrets.json`의 Bootstrap token으로 현재 도메인용 패스키를 한 번 등록합니다. 기존 계정과 패스키는 삭제되지 않습니다.

배포 후 Cloudflare에서 Account/Queues Edit 권한의 전용 API token을 만들고 Queue ID와 함께 Generator에 제공합니다. YouTube 쿠키, Hugging Face token, Cloudflare token은 Queue 메시지·작업 JSON·로그에 넣지 않습니다.

### Dashboard 환경 설정

Admin의 `권한·설정 → 서버 런타임 환경`에서 외부 dump URL, WebAuthn RP/origin, 자동 승격과 품질 임계치, Webhook timeout·서명키를 관리합니다. 일반 값은 즉시 반영되고 비밀값은 암호화된 write-only 값으로 저장됩니다. D1/R2/Queue binding과 `BOOTSTRAP_TOKEN`, `SECRET_ENCRYPTION_KEY`, `ARTIFACT_PRIVATE_KEY`는 Worker 부팅과 복호화의 신뢰 루트이므로 Dashboard에서는 상태만 표시하며 Cloudflare 배포 도구로만 교체합니다.

## Generator 실행

Apple Silicon Mac에서는 Docker가 아니라 호스트의 Metal/MPS와 MLX를 직접 사용합니다.

Generator의 기본 Admin 주소도 `https://mora.junx.dev`이며 `MORA_ADMIN_URL`로만 덮어씁니다.

```bash
Generator/scripts/setup-macos.sh
npm run generator
```

설치 검증은 `Generator/scripts/self-test-macos.sh`, 외부 음원 없는 전체 파이프라인 검증은 `node Generator/scripts/smoke-test-macos.mjs`로 실행합니다. 로그인 후 상시 실행은 `Generator/scripts/install-launch-agent.sh`로 등록합니다.

첫 실행에 표시되는 10자리 PIN을 `Admin → 기기 연결 → Generator 연결`에서 승인합니다. Generator는 전용 서비스 키를 직접 받아 `Generator/.mora-worker.json`에 mode `0600`으로 저장하고 다음 실행부터 자동 인증합니다. 작업 pull·완료·재시도도 이 서비스 키로 Mora Worker를 통해 수행하므로 Cloudflare 계정 ID나 API token은 Generator에 필요하지 않습니다. self-test에서 MPS backend, yt-dlp, ffmpeg, Demucs, ASR, aligner를 모두 통과한 워커만 PIN 연결을 요청하고 production 작업을 받습니다. `HF_TOKEN`이 없으면 diarization만 건너뜁니다.

Linux CUDA용 `Generator/Dockerfile`은 다른 GPU 호스트를 위한 보조 경로입니다. Docker Desktop의 Linux VM은 Mac의 Metal/MPS를 Generator에 전달하지 않으므로 Mac production Generator에는 사용하지 않습니다.

## Collector 연결

`~/Documents/SongTitle`의 소스는 `packages/songtitle` 워크스페이스 패키지로 포함되어 있습니다. Collector는 별도 adapter 설정 없이 Melon, Bugs, Genie, FLO, Vibe, Genius, LyricFind, Shazam에서 성공한 원문을 모두 Admin에 제출합니다.

```bash
npm run collector
```

첫 실행에 표시되는 10자리 PIN을 `Admin → 권한·설정 → Collector 연결`에서 승인하면 서비스 키가 로컬 보안 파일에 자동 저장됩니다. 기본 Admin 주소는 `https://mora.junx.dev`이며, 로컬 Worker를 사용할 때만 `MORA_ADMIN_URL=http://localhost:8787 npm run collector`로 덮어씁니다. 수집 한도·주기·국가, SongTitle provider, 브라우저 모드, Genius/LyricFind 키는 Admin의 Collector 런타임에서 관리하며 Collector가 주기적으로 다시 읽습니다. 브라우저를 쓰려면 호스트에 한 번 `corepack pnpm --filter @mora/songtitle exec playwright install chromium`을 실행합니다.

다른 라이브러리를 쓰려면 `packages/contracts`의 `LyricsProvider`를 default 또는 `provider`로 export하고 Dashboard에 호스트의 절대 모듈 경로를 저장하면 내장 SongTitle 대신 사용됩니다.

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
