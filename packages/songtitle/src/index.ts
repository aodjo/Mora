export * from "./types.js";
export { LyricsRouter, loadKeysFromEnv, describeAvailability, type RouterOptions, type ProviderAvailability } from "./router.js";
export { createBrowserRunner, type BrowserRunner, type BrowserOptions } from "./browser.js";
export { allProviders, providerByName, melon, bugs, genie, flo, vibe, genius, lyricfind, shazam } from "./providers/index.js";
export { htmlToPlainText, parseLrc, formatTime } from "./util/lyrics.js";
// 테스트가 소스 경로 대신 패키지 엔트리로 들어올 수 있게 매칭 헬퍼도 내보낸다.
// (소스로 직접 들어가면 tsc가 dist/packages/songtitle/src/ 에 사본을 만드는데,
//  거기서는 cheerio가 해석되지 않는다 — pnpm이 호이스트하지 않기 때문.)
export { comparable, pickTrack, sameArtist, sameTitle, type TrackCandidate } from "./util/match.js";
