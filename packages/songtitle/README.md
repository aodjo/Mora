# @mora/songtitle

`~/Documents/SongTitle`에서 Mora 워크스페이스로 이관한 멀티 provider 가사 라우터입니다. Collector의 기본 `LyricsProvider` adapter가 이 패키지를 사용합니다.

여러 음악 서비스에서 가사를 **한 번에 병렬로** 가져오는 라우터입니다.
각 서비스는 독립된 "프로바이더 어댑터"로 구현되어 있고, `LyricsRouter`가
전체를 동시에 호출해 성공한 결과를 **전부** 모아 돌려줍니다. (하나가 실패해도
나머지에 영향 없음)

지원 프로바이더: **Melon · Bugs · Genie · FLO · Vibe · Genius · LyricFind · Shazam**

HTTP로 못 가져오는 프로바이더(Genius/LyricFind/Shazam)는 **헤드리스 Chromium 크롤링**으로
폴백합니다. (`--browser` 옵션 / 라이브러리 `browser: true`)

## 설치 & 빌드

```bash
corepack pnpm install
corepack pnpm --filter @mora/songtitle build

# 브라우저 폴백(--browser)을 쓰려면 Chromium 설치가 필요
corepack pnpm --filter @mora/songtitle exec playwright install chromium
```

개발 중에는 빌드 없이 실행:

```bash
corepack pnpm --filter @mora/songtitle dev -- "너를 처음 본 순간" -a "검정치마"
```

## CLI 사용법

```bash
# 위치 인자로 제목
corepack pnpm --filter @mora/songtitle dev -- "너를 처음 본 순간" -a "검정치마"

# 특정 프로바이더만, 타임 싱크 표시
corepack pnpm --filter @mora/songtitle dev -- -t Magenta -p melon,genie,vibe --synced

# 브라우저 폴백: genius 등을 키 없이 헤드리스 Chromium으로 크롤링
corepack pnpm --filter @mora/songtitle dev -- "Bohemian Rhapsody" -a Queen --browser

# JSON 출력 (다른 도구로 파이프)
corepack pnpm --filter @mora/songtitle dev -- "Antifreeze" -a 검정치마 --json
```

| 옵션 | 설명 |
|------|------|
| `-t, --title` | 곡 제목 (위치 인자로도 가능) |
| `-a, --artist` | 아티스트명 (검색 정확도 ↑) |
| `-p, --providers a,b,c` | 사용할 프로바이더만 지정 |
| `--timeout <초>` | 프로바이더별 타임아웃 (기본 12초) |
| `--synced` | 타임 싱크 가사를 `[mm:ss.xx]`로 표시 |
| `--browser` | HTTP 실패 프로바이더를 헤드리스 Chromium으로 크롤링 (genius/lyricfind/shazam) |
| `--headful` | 브라우저를 화면에 띄워 실행 (봇 차단 우회에 유리, `--browser`와 함께) |
| `--json` | 결과 전체를 JSON으로 출력 |

## 라이브러리 사용법

```ts
import { LyricsRouter } from "@mora/songtitle";

const router = new LyricsRouter({ timeoutMs: 10_000 });

const { results, outcomes } = await router.fetchAll({
  title: "너를 처음 본 순간",
  artist: "검정치마",
});

for (const r of results) {
  console.log(`[${r.provider}] ${r.title} — ${r.artist}`);
  console.log(r.lyrics);
  if (r.synced) console.log(`싱크 라인 ${r.synced.length}개`);
}

// 프로바이더별 상태(성공/미검색/스킵/오류) 확인
console.table(outcomes.map(({ provider, status, elapsedMs }) => ({ provider, status, elapsedMs })));
```

### 일부 프로바이더만 쓰기

```ts
import { LyricsRouter, melon, genie, vibe } from "@mora/songtitle";

const router = new LyricsRouter({ providers: [melon, genie, vibe] });
```

## 프로바이더 현황

실제 엔드포인트로 검증한 결과입니다. (스크래핑 특성상 변할 수 있음)

| 프로바이더 | 키 | 상태 | 타임싱크 | 비고 |
|-----------|----|------|:-------:|------|
| Melon | 불필요 | ✅ 동작 | – | `search/total` 페이지 스크랩 (song 검색 페이지는 JS 렌더라 사용 불가) |
| Bugs | 불필요 | ✅ 동작 | – | 트랙 페이지 `.lyricsContainer` 스크랩 |
| Genie | 불필요 | ✅ 동작 | ✅ | `get_msl.asp` JSONP에서 ms 단위 싱크 가사 |
| FLO | 불필요 | ✅ 동작 | △ | 트랙 상세 `lyrics` (LRC면 싱크 파싱) |
| Vibe | 불필요 | ✅ 동작 | ✅ | Naver musicapiweb JSON API |
| Genius | 토큰 or `--browser` | ✅ 동작 | – | 토큰 있으면 API, 없으면 **브라우저 크롤링** (검증됨). 곡 없으면 not_found |
| Shazam | `--browser` | ✅ 동작 | – | 홈에서 검색어 입력 → 자동완성 첫 곡 → 곡 페이지 가사 스크랩 (한/영 검증됨) |
| LyricFind | **키 필요** | 🔑 키 | – | 사이트가 **CAPTCHA**로 보호됨(직접 URL도 퍼즐 요구) → 브라우저로 못 뚫음. API 키 사용 |

> **브라우저 폴백 요약**: `--browser`를 켜면 Genius/Shazam은 키 없이 헤드리스 Chromium으로
> 크롤링합니다(둘 다 검증됨). 여러 브라우저 프로바이더는 하나의 Chromium을 공유하며 **직렬 실행**
> 됩니다(동시 실행 시 자원 경합으로 타임아웃).
>
> **헤드리스 탐지 회피(stealth)**: `playwright-extra` + stealth 플러그인 + 풀 Chromium의
> new-headless(`channel: "chromium"`)를 사용해 UA/클라이언트 힌트가 `HeadlessChrome`이 아니라
> 정상 `Chrome`으로 나가고 `navigator.webdriver` 등 JS 시그널도 깨끗합니다(검증됨).
>
> **LyricFind만 예외**: 헤드리스 탐지 회피와 무관하게, 검색·가사 페이지가 CAPTCHA 퍼즐로
> 막혀 있어 자동화로는 통과 불가입니다. LyricFind는 API 키로만 사용하세요.

## API 키

대부분의 국내 서비스는 공개 웹/JSON 엔드포인트를 사용하므로 키가 필요 없지만,
아래 둘은 키가 있어야 하며 없으면 자동으로 `skipped` 처리됩니다.

| 프로바이더 | 환경변수 | 비고 |
|-----------|----------|------|
| Genius | `GENIUS_ACCESS_TOKEN` | genius.com API 토큰 (검색용, 가사는 페이지 스크랩) |
| LyricFind | `LYRICFIND_API_KEY` (+`LYRICFIND_TERRITORY`) | 라이선스 B2B API |

```bash
export GENIUS_ACCESS_TOKEN=xxxx
export LYRICFIND_API_KEY=yyyy
```

## 아키텍처

```
src/
  types.ts            공통 타입 (Provider, LyricsResult, SearchQuery ...)
  http.ts             타임아웃/Abort 지원 fetch 헬퍼
  browser.ts          Chromium 크롤러 러너 (playwright-extra+stealth, new-headless, 동적 import)
  router.ts           LyricsRouter — 전체 프로바이더 병렬 실행 + 브라우저 러너 관리
  util/lyrics.ts      HTML→평문, LRC 파싱, 시간 포맷 등
  providers/
    melon.ts  bugs.ts        (HTML 스크랩)
    genie.ts  flo.ts  vibe.ts (JSON/JSONP API, 타임 싱크 지원)
    genius.ts lyricfind.ts   (해외; API + 브라우저 폴백)
    shazam.ts               (HTTP + 브라우저 폴백)
    index.ts               프로바이더 레지스트리
  cli.ts              커맨드라인 인터페이스
```

### 브라우저 폴백 동작 방식

- `browser: true`(또는 `--browser`)이면 라우터가 `fetchAll` 동안 Chromium을 **한 번만** 띄우고,
  브라우저 대응 프로바이더들이 각자 별도 컨텍스트로 공유해서 쓴 뒤 종료합니다.
- 각 프로바이더는 먼저 HTTP/API를 시도하고, 실패하면 `ctx.browser`로 사이트를 크롤링합니다.
- 키가 필요한 프로바이더(genius/lyricfind)도 `--browser`가 켜져 있으면 `skipped` 대신 실행됩니다.
- `playwright`는 동적 import 되므로, 브라우저 모드를 쓰지 않으면 설치돼 있지 않아도 됩니다.

### 새 프로바이더 추가

`Provider` 인터페이스만 구현해 `providers/index.ts`의 `allProviders`에 등록하면 됩니다.

```ts
import type { Provider } from "../types.js";

export const myService: Provider = {
  name: "myservice",
  async fetch(query, ctx) {
    // 검색 → 가사 조회
    return { provider: "myservice", lyrics: "...", title: query.title };
    // 못 찾으면 null, 오류면 throw
  },
};
```

## 주의

- 국내 서비스의 웹/비공식 엔드포인트는 **사이트 구조 변경 시 깨질 수 있습니다.**
  프로바이더는 방어적으로 작성되어 실패 시 해당 항목만 `error`/`not_found`로 표시됩니다.
- **검색 정확도는 제목에 달려 있습니다.** `title`에 가사 한 줄을 넣으면 엉뚱한 곡이
  잡힐 수 있으니, 실제 곡 제목 + `--artist`를 넣는 것이 가장 정확합니다.
- **Shazam**은 `/search?query=`로 직접 가면 SPA가 렌더되지 않으므로, 실제 사람처럼 홈에서
  검색창에 입력 → 자동완성 첫 곡 선택 → 곡 페이지에서 가사를 스크랩합니다. (한/영 모두 검증됨)
- **LyricFind**는 사이트 전체가 CAPTCHA 퍼즐로 보호되어 자동화로는 통과할 수 없습니다.
  **API 키**(`LYRICFIND_API_KEY`)로만 사용하세요. 키가 없으면 (브라우저 폴백 없이) 바로 `skip` 됩니다.
- 브라우저 프로바이더는 하나의 Chromium을 공유하며 순차 실행되므로, 여러 개를 켜면 그만큼 느려집니다.
- 가사 저작권은 각 서비스/권리자에 있습니다. 개인적·비상업적 용도로만 사용하고,
  각 서비스의 이용약관과 저작권을 준수하세요.
