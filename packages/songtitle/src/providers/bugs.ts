import * as cheerio from "cheerio";
import type { Provider } from "../types.js";
import { getText, type HttpOptions } from "../http.js";
import { htmlToPlainText } from "../util/lyrics.js";
import { pickTrack } from "../util/match.js";

const BASE = "https://music.bugs.co.kr";

interface BugsRow {
  trackId: string;
  title: string;
  artist: string;
}

/**
 * Bugs — 트랙 검색 결과 행(p.title / p.artist)에서 질의와 일치하는 곡을 고른 뒤
 * 트랙 페이지의 .lyricsContainer > xmp 에서 가사를 스크랩.
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
      trackId = pickTrack(parseSearchRows(searchHtml), query, (row) => row)?.trackId;
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

/** 트랙 검색 목록: tr[trackid] 행마다 p.title a / p.artist a */
function parseSearchRows(html: string): BugsRow[] {
  const $ = cheerio.load(html);
  const rows: BugsRow[] = [];
  $("tr[trackid]").each((_, el) => {
    const row = $(el);
    const trackId = row.attr("trackid");
    if (!trackId) return;
    const titleLink = row.find("p.title a").first();
    const title = (titleLink.attr("title") ?? titleLink.text()).trim();
    if (!title) return;
    rows.push({ trackId, title, artist: row.find("p.artist a").first().text().trim() });
  });
  return rows;
}
