import * as cheerio from "cheerio";
import type { LyricsResult, Provider, ProviderContext, SearchQuery } from "../types.js";
import { getJson, getText, type HttpOptions } from "../http.js";

interface GeniusSearchResp {
  response?: {
    hits?: Array<{
      type?: string;
      result?: {
        id?: number;
        url?: string;
        title?: string;
        primary_artist?: { name?: string };
      };
    }>;
  };
}

/**
 * Genius — 토큰이 있으면 공식 API로 검색 후 곡 페이지 HTML을 스크랩,
 * 토큰이 없거나 실패하고 브라우저 폴백이 켜져 있으면 헤드리스 Chromium으로 크롤링.
 * (가사는 API에 없고 [data-lyrics-container] 안에만 존재)
 */
export const genius: Provider = {
  name: "genius",
  requiresKey: true,
  keyName: "GENIUS_ACCESS_TOKEN",
  browserCapable: true,
  async fetch(query, ctx) {
    const token = ctx.keys.GENIUS_ACCESS_TOKEN;
    if (token) {
      try {
        const viaApi = await geniusViaApi(query, ctx, token);
        if (viaApi) return viaApi;
      } catch (err) {
        if (!ctx.browser) throw err; // 브라우저 폴백 없으면 그대로 오류
      }
    }
    if (ctx.browser) return geniusViaBrowser(query, ctx);
    throw new Error("missing GENIUS_ACCESS_TOKEN");
  },
};

async function geniusViaApi(query: SearchQuery, ctx: ProviderContext, token: string): Promise<LyricsResult | null> {
  const opts: HttpOptions = {
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
    fetchImpl: ctx.fetchImpl,
  };
  const q = [query.title, query.artist].filter(Boolean).join(" ");

  const search = await getJson<GeniusSearchResp>(`https://api.genius.com/search?q=${encodeURIComponent(q)}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}` },
  });
  const hit = search.response?.hits?.find((h) => h.type === "song")?.result;
  if (!hit?.url) return null;

  const lyrics = scrapeLyricsHtml(await getText(hit.url, opts));
  if (!lyrics) return null;

  return {
    provider: "genius",
    title: hit.title,
    artist: hit.primary_artist?.name,
    lyrics,
    url: hit.url,
    trackId: hit.id != null ? String(hit.id) : undefined,
  };
}

async function geniusViaBrowser(query: SearchQuery, ctx: ProviderContext): Promise<LyricsResult | null> {
  const q = [query.title, query.artist].filter(Boolean).join(" ");
  return ctx.browser!.run(async (page) => {
    await page.goto(`https://genius.com/search?q=${encodeURIComponent(q)}`, {
      waitUntil: "domcontentloaded",
    });
    // 검색 결과 카드 첫 항목이 최상위 매치 (없으면 = 곡이 Genius에 없음 → not_found)
    const card = await page.waitForSelector("a.mini_card", { timeout: ctx.timeoutMs }).catch(() => null);
    if (!card) return null;
    const href = await card.getAttribute("href");
    if (!href) return null;

    await page.goto(href, { waitUntil: "domcontentloaded" });
    const hasLyrics = await page.waitForSelector('[data-lyrics-container="true"]', { timeout: ctx.timeoutMs }).catch(() => null);
    if (!hasLyrics) return null;
    // 렌더된 DOM을 HTTP 경로와 동일한 cheerio 추출기로 처리 (헤더/설명 크루프트 배제)
    const lyrics = scrapeLyricsHtml(await page.content());
    if (!lyrics) return null;

    const pageTitle = (await page.title()).replace(/\s*Lyrics\s*\|\s*Genius.*$/i, "").trim();
    return {
      provider: "genius",
      title: pageTitle || query.title,
      artist: query.artist,
      lyrics,
      url: href,
    };
  });
}

/** genius 곡 페이지 HTML에서 가사 추출 */
function scrapeLyricsHtml(html: string): string {
  const $ = cheerio.load(html);
  const containers = $('[data-lyrics-container="true"]');
  if (containers.length === 0) return "";
  // 첫 컨테이너에 들어있는 헤더(기여자/번역/설명/Read More) 블록 제거
  containers.find('[class*="LyricsHeader"], [class*="SongBioPreview"], [class*="RightSidebar"]').remove();
  let lyrics = "";
  containers.each((_, el) => {
    $(el).find("br").replaceWith("\n");
    lyrics += $(el).text() + "\n";
  });
  return lyrics
    .split("\n")
    .map((s) => s.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
