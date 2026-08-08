import * as cheerio from "cheerio";
import type { LyricLine, Provider } from "../types.js";
import { getText, type HttpOptions } from "../http.js";
import { htmlToPlainText, plainFrom } from "../util/lyrics.js";

const BASE = "https://www.genie.co.kr";

/**
 * Genie — 검색으로 songId를 찾고, get_msl.asp(JSONP)에서 타임 싱크 가사를 받는다.
 * JSONP 실패 시 상세 페이지 스크랩으로 폴백.
 */
export const genie: Provider = {
  name: "genie",
  async fetch(query, ctx) {
    const opts: HttpOptions = {
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      fetchImpl: ctx.fetchImpl,
      headers: { Referer: `${BASE}/` },
    };
    const q = [query.title, query.artist].filter(Boolean).join(" ");

    let songId = query.trackId;
    if (!songId) {
      const html = await getText(`${BASE}/search/searchMain?query=${encodeURIComponent(q)}`, opts);
      songId = html.match(/fnViewSongInfo\('(\d+)'/)?.[1] ?? html.match(/xgnm=(\d+)/)?.[1] ?? html.match(/songid["'=:\s]+(\d+)/i)?.[1];
    }
    if (!songId) return null;

    let synced: LyricLine[] | undefined;
    let lyrics = "";

    try {
      const jsonp = await getText(`https://dn.genie.co.kr/app/purchase/get_msl.asp?path=a&songid=${songId}`, opts);
      synced = parseGenieMsl(jsonp);
      lyrics = synced.map((l) => l.text).join("\n");
    } catch {
      /* JSONP 실패 → 아래 폴백 */
    }

    const detailUrl = `${BASE}/detail/songInfo?xgnm=${songId}`;
    if (!lyrics) {
      const $ = cheerio.load(await getText(detailUrl, opts));
      lyrics = htmlToPlainText($("#pLyrics p").html() ?? $(".lyrics").html() ?? "");
    }
    if (!lyrics) return null;

    return {
      provider: "genie",
      title: query.title,
      artist: query.artist,
      lyrics: plainFrom(lyrics, synced),
      synced: synced && synced.length ? synced : undefined,
      url: detailUrl,
      trackId: songId,
    };
  },
};

/** get_msl.asp 응답: { "400":"line", "12040":"line", ... } (키=ms) */
function parseGenieMsl(jsonp: string): LyricLine[] {
  const start = jsonp.indexOf("{");
  const end = jsonp.lastIndexOf("}");
  if (start < 0 || end < 0) return [];
  let obj: Record<string, string>;
  try {
    obj = JSON.parse(jsonp.slice(start, end + 1));
  } catch {
    return [];
  }
  return Object.entries(obj)
    .map(([ms, text]) => ({ timeMs: Number(ms), text: String(text) }))
    .filter((l) => Number.isFinite(l.timeMs))
    .sort((a, b) => a.timeMs - b.timeMs);
}
