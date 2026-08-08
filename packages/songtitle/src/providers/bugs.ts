import * as cheerio from "cheerio";
import type { Provider } from "../types.js";
import { getText, type HttpOptions } from "../http.js";
import { htmlToPlainText } from "../util/lyrics.js";

const BASE = "https://music.bugs.co.kr";

/**
 * Bugs — 트랙 검색 후 트랙 페이지의 .lyricsContainer > xmp 에서 가사를 스크랩.
 */
export const bugs: Provider = {
  name: "bugs",
  async fetch(query, ctx) {
    const opts: HttpOptions = {
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      fetchImpl: ctx.fetchImpl,
      headers: { Referer: `${BASE}/` },
    };
    const q = [query.title, query.artist].filter(Boolean).join(" ");

    let trackId = query.trackId;
    if (!trackId) {
      const searchHtml = await getText(`${BASE}/search/track?q=${encodeURIComponent(q)}`, opts);
      trackId = searchHtml.match(/\/track\/(\d+)/)?.[1] ?? searchHtml.match(/trackId=(\d+)/)?.[1];
    }
    if (!trackId) return null;

    const trackUrl = `${BASE}/track/${trackId}`;
    const $ = cheerio.load(await getText(trackUrl, opts));

    let lyrics = $(".lyricsContainer xmp").text().trim();
    if (!lyrics) lyrics = htmlToPlainText($(".lyricsContainer").html() ?? "");
    if (!lyrics) return null;

    const title = $("header.pgTitle h1").text().trim() || query.title;
    const artist =
      $('.basicInfo a[href*="/artist/"]').first().text().trim() || $('.info a[href*="/artist/"]').first().text().trim() || query.artist;

    return { provider: "bugs", title, artist, lyrics, url: trackUrl, trackId };
  },
};
