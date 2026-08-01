import * as cheerio from "cheerio";
import type { Provider } from "../types.js";
import { getText, type HttpOptions } from "../http.js";
import { htmlToPlainText } from "../util/lyrics.js";

const BASE = "https://www.melon.com";

/**
 * Melon — 웹 검색 후 곡 상세 페이지에서 가사를 스크랩.
 * Referer/UA 없이는 차단되는 경우가 많아 헤더를 붙인다.
 */
export const melon: Provider = {
  name: "melon",
  async fetch(query, ctx) {
    const opts: HttpOptions = {
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      fetchImpl: ctx.fetchImpl,
      headers: { Referer: `${BASE}/` },
    };
    const q = [query.title, query.artist].filter(Boolean).join(" ");

    // 통합검색(total)만 결과를 서버사이드로 렌더링한다. song/index.htm 은 JS로 채워짐.
    const songId =
      query.trackId ??
      extractSongId(
        await getText(
          `${BASE}/search/total/index.htm?q=${encodeURIComponent(q)}&section=song`,
          opts,
        ),
      );
    if (!songId) return null;

    const detailUrl = `${BASE}/song/detail.htm?songId=${songId}`;
    const $ = cheerio.load(await getText(detailUrl, opts));

    const lyricHtml = $("#d_video_summary").html() ?? $(".lyric").html() ?? "";
    const lyrics = htmlToPlainText(lyricHtml);
    if (!lyrics) return null;

    const title = $(".song_name").clone().children().remove().end().text().trim() || query.title;
    const artist =
      $(".artist a").first().attr("title")?.replace(/ 페이지 이동$/, "").trim() ||
      $(".artist_name").text().trim() ||
      query.artist;
    const album = $(".meta dl dd").first().text().trim() || undefined;

    return { provider: "melon", title, artist, album, lyrics, url: detailUrl, trackId: songId };
  },
};

function extractSongId(html: string): string | undefined {
  const m =
    html.match(/goSongDetail\('(\d+)'/) ??
    html.match(/playSong\('[^']*',\s*(\d+)/) ??
    html.match(/songId=(\d+)/);
  return m?.[1];
}
