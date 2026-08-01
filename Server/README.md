# Server

Cloudflare Worker 한 배포에서 다음 경계를 제공합니다.

- `/v1/*`: `PUBLIC_DB` 활성 alignment만 읽는 공개 API
- `/admin/api/*`: 패스키 session 또는 scope API key가 필요한 Control Plane
- `/admin/*`: `Admin/dist` 정적 Dashboard
- `AdminEventHub`: SSE fan-out Durable Object
- `GENERATION_QUEUE`: 외부 Generator용 HTTP pull Queue producer
- `ADMIN_ARTIFACTS`: 애플리케이션 수준 암호화 R2
- `PUBLIC_DUMPS`: 활성 공개 데이터만 포함한 SQLite dump R2

마이그레이션은 `migrations/public`과 `migrations/admin`으로 분리되어 있습니다. Public 스키마에는 텍스트 컬럼이 없습니다.

## 인프라 연결

```bash
corepack pnpm infra:login
corepack pnpm infra:provision
corepack pnpm infra:status
```

`infra:provision`은 D1 두 개, R2 두 개, Queue와 HTTP pull consumer를 생성하고 실제 D1 ID를 `wrangler.jsonc`에 기록한 후 migration·secret·배포·초기 dump까지 처리합니다. 재실행 시 기존 리소스와 `Server/.mora-infra-secrets.json`의 암호화 신뢰 루트를 재사용합니다.

## 런타임 설정

- `GET /admin/api/settings`: 허용된 설정과 Cloudflare binding/secret 상태 조회
- `PUT /admin/api/settings/:key`: 타입 검증 후 저장, 비밀값은 AES-256-GCM 암호화
- `DELETE /admin/api/settings/:key`: 기본값으로 복원

Dashboard에서 관리하는 값은 D1 `settings` 테이블을 통해 즉시 적용됩니다. secret 항목은 목록 응답에 평문이나 암호문을 포함하지 않습니다. 모든 저장·초기화는 `audit_log`에 값 없이 기록됩니다.

Cloudflare의 D1/R2/Queue binding과 다음 세 값은 Dashboard 관리 대상이 아닙니다.

- `BOOTSTRAP_TOKEN`: 최초 관리자 등록
- `SECRET_ENCRYPTION_KEY`: D1의 write-only 설정 및 Webhook URL 복호화
- `ARTIFACT_PRIVATE_KEY`: R2 artifact 데이터 키 복호화

이 값들은 Cloudflare Secret으로만 등록하며 API 응답에는 configured 여부만 표시합니다.
