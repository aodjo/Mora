import * as cheerio from "cheerio";
import type { Provider } from "../types.js";
import { getText, type HttpOptions } from "../http.js";
import { htmlToPlainText } from "../util/lyrics.js";
import { pickTrack } from "../util/match.js";

const BASE = "https://www.melon.com";

interface MelonRow {
  songId: string;
  title: string;
  artist: string;
}

/**
 * Melon — 통합검색 곡 목록에서 질의와 제목이 일치하는 곡을 고르고 상세 페이지에서 가사를
 * 스크랩. 첫 songId를 검증 없이 집던 시절 라틴어 가사 하나가 88곡에 붙었다.
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
    let songId = query.trackId;
    if (!songId) {
      const html = await getText(`${BASE}/search/total/index.htm?q=${encodeURIComponent(q)}&section=song`, opts);
      songId = pickTrack(parseSearchRows(html), query, (row) => row)?.songId;
    }
    if (!songId) return null;

    const detailUrl = `${BASE}/song/detail.htm?songId=${songId}`;
    const $ = cheerio.load(await getText(detailUrl, opts));

    const lyricHtml = $("#d_video_summary").html() ?? $(".lyric").html() ?? "";
    const lyrics = htmlToPlainText(lyricHtml);
    if (!lyrics) return null;

    const title = $(".song_name").clone().children().remove().end().text().trim() || query.title;
    const artist =
      $(".artist a")
        .first()
        .attr("title")
        ?.replace(/\s*-?\s*페이지 이동$/, "")
        .trim() ||
      $(".artist_name").text().trim() ||
      query.artist;
    const album = $(".meta dl dd").first().text().trim() || undefined;

    return { provider: "melon", title, artist, album, lyrics, url: detailUrl, trackId: songId };
  },
};

/** 곡 목록 행: goSongDetail('id') 링크가 있는 tr마다 playSong 링크의 title 속성 + 아티스트 셀 */
function parseSearchRows(html: string): MelonRow[] {
  const $ = cheerio.load(html);
  const rows: MelonRow[] = [];
  $("tr").each((_, el) => {
    const row = $(el);
    const songId = (row.html() ?? "").match(/goSongDetail\('(\d+)'\)/)?.[1];
    if (!songId) return;
    const playLink = row.find('a[href*="playSong"]').first();
    const title = (playLink.attr("title") ?? playLink.text()).trim();
    if (!title) return;
    rows.push({ songId, title, artist: row.find(".wrapArtistName a").first().text().trim() });
  });
  return rows;
}
