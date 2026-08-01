# SERVICE word-timing layer

가사 원문을 저장하거나 배포하지 않고, 클라이언트가 보유한 텍스트에 단어 단위 타이밍을 얹는 서비스입니다.

## 배포 구조

```text
데이터 생성 환경 (어디서든 실행)
  forced aligner의 타이밍 + 보유한 가사
       ↓
  Generator (Node.js 또는 Docker)
  - unilab-v1 토큰화
  - 지문·text_hash 생성
  - 시간 범위 검증
  - 가사를 제거한 contribution 생성
       ↓ HTTPS /v1/contribute
Cloudflare Worker
  - 공개 정렬 API
  - contribution 인증
       ↓ D1 binding
Cloudflare D1
  - 지문과 숫자 타이밍만 저장
```

두 실행 환경은 완전히 분리됩니다.

- **Serving plane**: Cloudflare Worker + D1. 플레이어 요청 처리와 공개 데이터 배포를 담당합니다.
- **Generation plane**: 상태 없는 Node.js 서버. 노트북, NAS, VM, 컨테이너 어디서든 실행하며 생성 결과를 Worker에 업로드합니다.
- **Shared core**: 토크나이저, 지문, 매칭, 신뢰도, 보간 코드는 두 환경이 공유합니다.

Generator에는 Demucs·WhisperX·MFA·NeMo 자체를 아직 포함하지 않습니다. 현재 경계는 외부 forced aligner가 만든 `line_spans`와 `word_spans`를 받아 검증·지문화·업로드하는 단계입니다. 음원별 ML 실행기는 이 앞에 어댑터로 연결합니다.

## 구현 범위

- `unilab-v1`: NFC, 길이 보존 폴딩, 괄호 마스킹, 섹션 헤더 제외, 어절 토큰화
- 원문 유니코드 코드포인트 좌표로 되돌리는 NFC 오프셋 매핑
- 정준형 SHA-256 16자리 해시와 길이·타입 지문
- 줄/토큰 2단계 Needleman–Wunsch 정렬
- `word` / `word-approx` / `line` 폴백과 미매칭 토큰 보간
- D1 BLOB에 숫자 배열만 저장하는 마이그레이션
- Worker API: align, fingerprint align, tokenize, contribute, dump redirect
- Generator API: build, publish, tokenize
- LRC-A2, Lyricsfile, TTML, WebVTT 숫자 오버레이 뷰

## Cloudflare Worker + D1

Node.js 22.5 이상과 Cloudflare 계정이 필요합니다.

### 로컬 실행

```bash
npm install
cp Server/.dev.vars.example Server/.dev.vars
npm run worker:types
npm run d1:migrate:local
npm run dev:worker
```

로컬 Worker는 기본적으로 `http://127.0.0.1:8787`에서 실행됩니다. `Server/.dev.vars`의 `CONTRIBUTE_TOKEN`이 기여 API 인증에 사용됩니다.

### Cloudflare 배포

먼저 D1을 만들고 출력된 ID로 [`Server/wrangler.jsonc`](./Server/wrangler.jsonc)의 `database_id`를 교체합니다.

```bash
npx wrangler d1 create service-word-timing --location=apac
npm run worker:types
npm run d1:migrate:remote
npx wrangler secret put CONTRIBUTE_TOKEN --config Server/wrangler.jsonc
npx wrangler secret put DUMP_URL --config Server/wrangler.jsonc
npm run worker:deploy
```

`DUMP_URL`은 정기적으로 게시한 SQLite 덤프의 주소입니다. `GET /v1/dump`는 이 주소로 리다이렉트합니다.

Worker 런타임의 최신 D1에서 직접 SQLite 파일을 덤프하는 API는 제공되지 않습니다. 주간 배포 작업은 `wrangler d1 export --remote`로 SQL을 내보내고 SQLite 파일로 변환한 뒤 R2나 다른 정적 스토리지에 올려야 합니다.

```bash
npx wrangler d1 export service-word-timing --remote --output=service.sql --config Server/wrangler.jsonc
sqlite3 service.sqlite < service.sql
```

`npm run worker:build`는 실제 배포 없이 Worker 번들만 검증합니다.

## 데이터 Generator

Generator는 DB를 갖지 않으며 입력 가사는 요청 처리 메모리에서만 사용합니다.

### 로컬 실행

```bash
npm run build
GENERATOR_HOST=127.0.0.1 \
GENERATOR_PORT=3100 \
SERVICE_PUBLISH_URL=https://your-worker.example \
SERVICE_PUBLISH_TOKEN=replace-me \
npm start
```

| 환경 변수 | 기본값 | 설명 |
|---|---:|---|
| `GENERATOR_HOST` | `127.0.0.1` | Generator 리슨 주소 |
| `GENERATOR_PORT` | `3100` | Generator 포트 |
| `SERVICE_PUBLISH_URL` | 없음 | 업로드할 Worker base URL |
| `SERVICE_PUBLISH_TOKEN` | 없음 | Worker의 `CONTRIBUTE_TOKEN`과 같은 값 |

### Docker 실행

```bash
docker build -f Generator/Dockerfile -t service-generator .
docker run --rm -p 3100:3100 \
  -e SERVICE_PUBLISH_URL=https://your-worker.example \
  -e SERVICE_PUBLISH_TOKEN=replace-me \
  service-generator
```

### contribution 만들기

`POST /v1/build`는 원문과 forced-alignment 결과를 받아 가사가 없는 업로드 payload를 반환합니다.

```json
{
  "isrc": "KRA382400123",
  "text": "나는 오늘 밤에\n너를 기다렸어",
  "duration_ms": 214000,
  "line_spans": [[12000, 13400], [13600, 14600]],
  "word_spans": [
    [0, 12000, 12350],
    [1, 12350, 12800],
    [2, 12800, 13400],
    [3, 13600, 14000],
    [4, 14000, 14600]
  ],
  "source": "forced-align"
}
```

응답에는 `text`가 없고 `text_hash`, `fingerprint`, 타이밍만 남습니다. 같은 본문을 `POST /v1/publish`에 보내면 설정된 Worker의 `/v1/contribute`로 바로 업로드합니다.

## Worker API

| 경로 | 설명 |
|---|---|
| `POST /v1/align` | 클라이언트 텍스트를 D1 정렬본과 매칭하여 코드포인트 오프셋 반환 |
| `POST /v1/align/fingerprint` | 텍스트 대신 지문으로 매칭하여 토큰 인덱스 반환 |
| `POST /v1/tokenize` | `[start, end, 원문 줄 번호]` 반환 |
| `POST /v1/contribute` | Generator payload를 D1에 upsert. Bearer 토큰 필수 |
| `GET /v1/dump` | `DUMP_URL`로 리다이렉트 |
| `GET /health` | 상태 확인 |

### 텍스트 정렬 예시

```bash
curl -X POST https://your-worker.example/v1/align \
  -H 'content-type: application/json' \
  -d '{"isrc":"KRA382400123","text":"나는 오늘 밤에 (oh)\n너를 기다렸어","duration_ms":214000}'
```

```json
{
  "tier": "word",
  "confidence": 1,
  "tokenizer": "unilab-v1",
  "offset_unit": "codepoint",
  "alignment_id": 1,
  "lines": [[0, 13, 12000, 13400], [14, 21, 13600, 14600]],
  "spans": [[0, 2, 12000, 12350], [3, 5, 12350, 12800]]
}
```

오프셋은 요청 원문의 유니코드 코드포인트 기준이며 끝 오프셋은 exclusive입니다. 등록 길이와 요청 `duration_ms`가 모두 있으면 `max(5초, 등록 길이의 2%)` 이내인 정렬본만 후보로 사용합니다.

`?format=spans|lrc-a2|lyricsfile|ttml|webvtt`를 지원합니다. 텍스트 전제 포맷에는 가사 대신 코드포인트 범위를 싣기 때문에 기존 플레이어용 완성 가사 파일이 아닌 숫자 오버레이입니다.

## 프라이버시 불변조건

- D1과 로컬 테스트 스키마에는 가사 컬럼이 없습니다.
- 지문·타이밍 배열은 D1 `BLOB`으로 저장됩니다.
- Generator와 Worker는 요청 본문, 예외 객체, 스택을 로깅하지 않습니다.
- 정준형과 토큰 문자열은 요청 처리 메모리 안에서만 존재합니다.
- 가사를 받는 응답에는 `Cache-Control: no-store`가 붙습니다.
- Generator가 Worker로 보내는 요청에는 원문이 포함되지 않습니다.

Cloudflare Logpush, Workers Observability 또는 외부 APM을 켤 때도 request body와 예외 로컬 변수 캡처를 비활성화해야 합니다.

## 프로젝트 구조

```text
Server/
  src/                      Cloudflare Worker와 D1 저장소
  migrations/               D1 스키마 마이그레이션
  wrangler.jsonc            Worker와 D1 binding 설정
Generator/
  src/                      휴대 가능한 생성·업로드 서버
  Dockerfile                Generator 컨테이너
packages/core/src/
  alignment/                NW 정렬, 신뢰도, 투영·보간
  tokenization/             unilab-v1, 지문, 해시
  storage/                  공통 저장소 계약과 기여 검증
  shared/                   공통 타입, 오류, 입력 검증
test/                       단위·통합·프라이버시 테스트
```

## 검증

```bash
npm run check
npm test
npm run worker:build
```

테스트는 토크나이저, 지문 매칭, 폴백, 보간, Generator의 원문 제거와 업로드, 저장소의 원문 비포함을 다룹니다. 로컬 D1 종단 간 검증은 `d1:migrate:local` 후 Generator `/v1/publish` → Worker `/v1/align` 순서로 수행할 수 있습니다.

## 아직 남은 범위

- Demucs/WhisperX/MFA/NeMo 실행 어댑터와 작업 큐
- `{artist, title, duration_ms}` 퍼지 탐색
- 기여자 계정·평판·스팸 방지
- D1 export → SQLite 변환 → R2 게시 자동화
- 실제 곡 데이터 기반 임계치와 토큰 경계 튜닝
# Mora
