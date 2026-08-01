# Mora Collector

KR/US/JP 인기곡과 최근 발매를 수집하고 MusicBrainz로 ISRC를 보강한 뒤, 사용자 가사 라이브러리의 모든 provider 원문과 YouTube Music 오디오 후보를 Admin Control Plane에 제출합니다.

기본 가사 수집기는 `packages/songtitle`입니다. Melon, Bugs, Genie, FLO, Vibe, Genius, LyricFind, Shazam을 병렬 조회하고 성공한 원문을 전부 제출합니다. `COLLECTOR_ONCE=1`이면 한 번만 실행합니다.

```bash
MORA_ADMIN_URL=https://mora.example \
MORA_COLLECTOR_TOKEN=mora_... \
pnpm dev:collector
```

선택 설정:

```bash
SONGTITLE_PROVIDERS=melon,bugs,genie
SONGTITLE_TIMEOUT_MS=12000
SONGTITLE_BROWSER=1
SONGTITLE_HEADFUL=0
GENIUS_ACCESS_TOKEN=...
LYRICFIND_API_KEY=...
LYRICFIND_TERRITORY=KR
```

브라우저 폴백은 `corepack pnpm --filter @mora/songtitle exec playwright install chromium`으로 Chromium을 설치한 뒤 사용합니다. 외부 가사 라이브러리로 교체할 때만 `LyricsProvider` 객체를 default 또는 `provider`로 export하고 `LYRICS_LIBRARY_MODULE`에 모듈 경로를 지정합니다.
