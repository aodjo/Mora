# Mora Collector

KR/US/JP 인기곡과 최근 발매를 수집하고 MusicBrainz로 ISRC를 보강한 뒤, 사용자 가사 라이브러리의 모든 provider 원문과 YouTube Music 오디오 후보를 Admin Control Plane에 제출합니다.

`COLLECTOR_DAILY_BUDGET`은 가사 데이터를 한 번에 모아 두는 배치 크기가 아니라 실행당 후보 상한입니다. 후보 순위만 먼저 정한 뒤 `1곡 식별 → YouTube Music/가사 수집 → Admin 작업 큐에 즉시 전송 → 다음 곡` 순서로 처리합니다. Generator는 Collector 전체 실행이 끝날 때까지 기다리지 않고 첫 작업부터 바로 가져갑니다.

기본 가사 수집기는 `packages/songtitle`입니다. Melon, Bugs, Genie, FLO, Vibe, Genius, LyricFind, Shazam을 병렬 조회하고 성공한 원문을 전부 제출합니다.

```bash
npm run collector
```

로컬에는 Admin 주소와 Collector 서비스 키만 둡니다. 수집 국가·주기·한도, SongTitle provider, 브라우저 모드, Genius/LyricFind 키와 외부 provider 경로는 `Admin → 권한·설정 → Collector 런타임`에서 관리합니다. Collector는 시작할 때 설정을 받고, 실행 대기 중에는 최대 60초마다 변경 여부를 다시 확인합니다. 비밀값은 Dashboard에 재노출되지 않고 `collector.config.read` 권한을 가진 Collector에만 전달됩니다.

첫 실행 시 CLI가 10자리 PIN을 표시합니다. `Admin → 권한·설정 → Collector 연결`에 PIN을 입력하면 Collector가 서비스 키를 직접 받아 `Collector/.mora-collector.json`에 mode `0600`으로 저장합니다. 이후 실행은 자동 인증됩니다. 기본 Admin 주소는 `https://mora.junx.dev`입니다. 로컬 Worker를 사용할 때만 `MORA_ADMIN_URL=http://localhost:8787 npm run collector`로 실행합니다.

브라우저 폴백은 `corepack pnpm --filter @mora/songtitle exec playwright install chromium`으로 Chromium을 설치한 뒤 Dashboard에서 활성화합니다. 외부 가사 라이브러리는 `LyricsProvider` 객체를 default 또는 `provider`로 export해야 하며, Collector가 실행되는 호스트의 절대 경로를 Dashboard에 입력합니다.
