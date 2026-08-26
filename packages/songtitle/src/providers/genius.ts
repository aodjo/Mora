import * as cheerio from "cheerio";
import type { LyricsResult, Provider, ProviderContext, SearchQuery } from "../types.js";
import { getJson, getText, httpGet, type HttpOptions } from "../http.js";
import { pickTrack, sameArtist, sameTitle } from "../util/match.js";

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
 * 없으면 곡 URL을 직접 조립해 곡 페이지만 읽는다(키리스 폴백).
 * 브라우저 폴백이 켜져 있으면 마지막으로 헤드리스 Chromium 크롤링.
 * (가사는 API에 없고 [data-lyrics-container] 안에만 존재)
 *
 * 키리스 폴백이 "검색"을 하지 않고 URL을 조립하는 이유는 genius.com/robots.txt가
 * `Disallow: /api/*` 와 `Disallow: /search?*` 로 검색 경로를 전부 막아두었기 때문이다.
 * 곡 페이지(/{Artist}-{title}-lyrics)는 막혀 있지 않으므로 그것만 읽는다.
 */
export const genius: Provider = {
  name: "genius",
  // 토큰이 없어도 슬러그 폴백으로 동작하므로 라우터가 스킵하면 안 된다.
  requiresKey: false,
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
    } else {
      const viaSlug = await geniusViaSlug(query, ctx);
      if (viaSlug) return viaSlug;
    }
    if (ctx.browser) return geniusViaBrowser(query, ctx);
    return null;
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
  // 검색 상위 hit이 늘 질의한 곡은 아니다 — 제목이 일치하는 hit만 후보로 삼는다.
  const songs = (search.response?.hits ?? []).filter((h) => h.type === "song");
  const hit = pickTrack(songs, query, (h) => ({ title: h.result?.title, artist: h.result?.primary_artist?.name }))?.result;
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

/** Genius 슬러그 한 조각 — 발음기호 제거, `&`는 and, 어퍼스트로피는 삭제, 나머지는 하이픈 */
function slugPart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/&/g, " and ")
    .replace(/[’'´`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/**
 * 슬러그로 곡을 찾을 수 있는 질의인가.
 *
 * Genius는 일본어·한국어 곡도 슬러그는 로마자로 적는다("一途" → ichizu). 원제를 그대로
 * 넣으면 슬러그에 CJK가 남아 반드시 404이므로, 라틴 문자로 적힌 질의에만 시도한다.
 * 로마자 표기를 우리가 지어낼 수는 없다 — 그쪽은 토큰이 있어야 검색으로 닿는다.
 */
function sluggable(query: SearchQuery): boolean {
  const joined = `${query.artist ?? ""} ${query.title}`;
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(joined)) return false;
  return slugPart(query.title).length > 0 && slugPart(query.artist ?? "").length > 0;
}

/** "Artist – Title Lyrics | Genius" 형태의 <title>에서 아티스트/제목을 뜯어낸다 */
function parsePageTitle(raw: string): { artist?: string; title?: string } {
  const cleaned = raw
    .replace(/\s*\|\s*Genius.*$/iu, "")
    .replace(/\s*Lyrics\s*$/iu, "")
    .trim();
  const parts = cleaned.split(/\s+[–—-]\s+/u);
  if (parts.length >= 2) return { artist: parts[0]!.trim(), title: parts.slice(1).join(" - ").trim() };
  return { title: cleaned };
}

/**
 * 토큰 없이 곡 페이지 URL을 직접 조립해 읽는다.
 *
 * 조립한 URL이 맞는 곡이라는 보장이 없으므로 받은 페이지를 반드시 검증한다. 실제로
 * `Lady-gaga-die-with-a-smile-lyrics`는 301로 `Genius-sinhala-translations-…`(싱할라어
 * 번역본)로 넘어간다 — 검증 없이 저장하면 영어 곡 자리에 번역문이 들어앉는다.
 */
async function geniusViaSlug(query: SearchQuery, ctx: ProviderContext): Promise<LyricsResult | null> {
  if (!sluggable(query)) return null;

  const opts: HttpOptions = {
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
    fetchImpl: ctx.fetchImpl,
  };
  // "(feat. …)" 꼬리는 슬러그에 들어가지 않는다.
  const bare = query.title.replace(/\s*[(（[]\s*(?:feat|ft|with|prod)\.?[^)）\]]*[)）\]]/giu, "").trim();
  const slug = `${slugPart(query.artist ?? "")}-${slugPart(bare || query.title)}-lyrics`;
  const url = `https://genius.com/${slug.charAt(0).toUpperCase()}${slug.slice(1)}`;

  let res: Response;
  try {
    res = await httpGet(url, opts);
  } catch {
    return null; // 404 = 그 슬러그의 곡이 없다
  }

  // 번역본 페이지로 리다이렉트된 경우 — 원곡이 아니다.
  if (/\/genius-[a-z0-9-]*translations?-/iu.test(new URL(res.url || url).pathname)) return null;

  const html = await res.text();
  const lyrics = scrapeLyricsHtml(html);
  if (!lyrics) return null;

  const $ = cheerio.load(html);
  const page = parsePageTitle($("title").text() || "");
  // 조립한 URL이므로 "받은 페이지가 정말 그 곡인가"를 제목으로 확인한다.
  if (!sameTitle(page.title, query.title)) return null;
  // 아티스트는 표기가 갈리므로 확인되면 신뢰하고, 확인 안 되면 제목 일치에 맡긴다.
  // 다만 명백히 다른 아티스트면(둘 다 라틴 표기라 비교가 성립한다) 거부한다.
  if (page.artist !== undefined && query.artist !== undefined && !sameArtist(page.artist, query.artist)) return null;

  return {
    provider: "genius",
    title: page.title ?? query.title,
    artist: page.artist ?? query.artist,
    lyrics,
    url: res.url || url,
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

    // 검색 카드 첫 항목이 다른 곡이었으면 여기서 걸러진다.
    const pageTitle = (await page.title()).replace(/\s*Lyrics\s*\|\s*Genius.*$/i, "").trim();
    if (pageTitle && !sameTitle(pageTitle, query.title)) return null;
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
