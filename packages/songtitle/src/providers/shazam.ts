import type { LyricsResult, Provider, ProviderContext, SearchQuery } from "../types.js";
import { sameTitle } from "../util/match.js";

/**
 * Shazam — 브라우저 폴백 전용에 가깝다.
 * shazam.com은 SPA라 `/search?query=`로 직접 가면 렌더가 안 되고,
 * 실제 사람처럼 **홈에서 검색창에 입력 → 자동완성 첫 곡 선택 → 곡 페이지**로 가야 한다.
 * 곡 페이지의 `[data-test-id="track_impression_songLyrics"]`(Apple Music 가사)에서 추출.
 * (구 웹 검색 API 엔드포인트는 현재 404/405로 죽어 있어 HTTP 단독으로는 동작하지 않음)
 */
export const shazam: Provider = {
  name: "shazam",
  browserCapable: true,
  needsBrowser: true, // 브라우저가 없으면 매번 조용히 null — 가용성 보고로 드러낸다
  async fetch(query, ctx) {
    if (!ctx.browser) return null; // 브라우저 없이는 방법이 없음(공개 API 사망)
    return shazamViaBrowser(query, ctx);
  },
};

async function shazamViaBrowser(query: SearchQuery, ctx: ProviderContext): Promise<LyricsResult | null> {
  const q = [query.title, query.artist].filter(Boolean).join(" ");
  return ctx.browser!.run(async (page) => {
    await page.goto("https://www.shazam.com/", { waitUntil: "domcontentloaded" });

    // 검색창은 접혀 있음(width 0). fill은 "not visible"로 실패하므로 focus 후 키보드 입력.
    const box = page.locator('input.searchInput, input[data-search-input="true"], input[role="combobox"]').first();
    await box.waitFor({ state: "attached", timeout: ctx.timeoutMs });
    await page.waitForTimeout(1500); // 홈 콘텐츠(히어로/차트) 렌더 안정화

    // 타이핑 전 홈페이지에 이미 있는 곡 링크(히어로/차트 프로모)를 기준선으로 잡아둔다.
    const songs = page.locator('a[href*="/song/"]');
    const readHrefs = () => songs.evaluateAll((els) => els.map((e) => e.getAttribute("href")).filter((h): h is string => !!h));
    const baseline = new Set(await readHrefs());

    await box.focus();
    await page.keyboard.type(q, { delay: 40 });

    // 자동완성 드롭다운은 ephemeral 하다. 열려 있는 동안, 기준선에 없던 "새" 곡 링크(=검색 결과)를 잡는다.
    let href: string | null = null;
    for (let i = 0; i < 18 && !href; i++) {
      await page.waitForTimeout(700);
      href = (await readHrefs()).find((h) => !baseline.has(h)) ?? null;
    }
    if (!href) return null;
    const url = new URL(href, "https://www.shazam.com").href;

    // 곡 페이지로 이동해 가사 추출
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const lyricsLoc = page.locator('[data-test-id="track_impression_songLyrics"], [class*="AppleMusicLyrics_lyrics__"]').first();
    try {
      await lyricsLoc.waitFor({ timeout: ctx.timeoutMs });
    } catch {
      return null;
    }
    let lyrics = (await lyricsLoc.innerText()).trim();
    lyrics = lyrics.replace(/^lyrics\s*/i, "").trim(); // 맨 앞 "Lyrics" 라벨 제거
    if (!lyrics) return null;

    // 자동완성 첫 항목이 다른 곡이었으면 여기서 걸러진다.
    const title = (await page.title()).replace(/\s*[-:].*$/, "").trim();
    if (title && !sameTitle(title, query.title)) return null;
    return {
      provider: "shazam",
      title: title || query.title,
      artist: query.artist,
      lyrics,
      url,
    };
  });
}
