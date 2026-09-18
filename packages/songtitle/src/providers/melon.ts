import * as cheerio from "cheerio";
import type { Provider } from "../types.js";
import { getText, type HttpOptions } from "../http.js";
import { htmlToPlainText } from "../util/lyrics.js";
import { sameTitle } from "../util/match.js";

const BASE = "https://www.melon.com";

/**
 * 검색 결과에서 상세 페이지를 몇 개까지 열어 볼지.
 *
 * 검색 화면이 제목을 안 주므로 곡마다 한 번씩 더 물어야 한다. 셋이면 원곡·라이브·리메이크가
 * 섞여 나와도 대개 그 안에 있고, 그보다 늘리면 한 곡에 드는 요청이 눈에 띄게 많아진다.
 */
const TRIES = 3;

/**
 * Melon — 통합검색에서 곡 번호를 얻고, **상세 페이지에서 제목을 확인한 뒤** 가사를 가져온다.
 *
 * 예전에는 검색 결과의 `<tr>` 행마다 제목·가수가 함께 있어 그 자리에서 곡을 골랐다. 2026-09
 * 확인: 그 화면이 `<li>` 로 바뀌어 페이지 전체에 `<tr>` 이 둘뿐이고, 행을 읽던 길이 통째로
 * 끊겨 **어떤 곡도 못 찾고 있었다**. 조용히 못 찾을 뿐이라 오류로도 안 보였다.
 *
 * 그래서 검색 화면에서는 **곡 번호만** 뽑는다(`goSongDetail('123')` — 이것은 마크업이 바뀌어도
 * 링크 안에 남는다). 제목은 상세 페이지 제 것을 읽어 질의와 견준다. 요청이 곡마다 한 번씩
 * 늘지만, 화면이 또 바뀌어도 버틴다.
 *
 * 제목 확인은 건너뛸 수 없다. 첫 songId 를 검증 없이 집던 시절 라틴어 가사 하나가 88곡에 붙었다.
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

    const wanted: string[] = [];
    if (query.trackId) {
      wanted.push(query.trackId);
    } else {
      const q = [query.title, query.artist].filter(Boolean).join(" ");
      // 통합검색(total)만 결과를 서버사이드로 렌더링한다. song/index.htm 은 JS로 채워짐.
      const html = await getText(`${BASE}/search/total/index.htm?q=${encodeURIComponent(q)}&section=song`, opts);
      for (const found of html.matchAll(/goSongDetail\('(\d+)'\)/g)) {
        const songId = found[1];
        if (songId !== undefined && !wanted.includes(songId)) wanted.push(songId);
      }
    }

    for (const songId of wanted.slice(0, TRIES)) {
      const detailUrl = `${BASE}/song/detail.htm?songId=${songId}`;
      const $ = cheerio.load(await getText(detailUrl, opts));

      // 제목 칸에는 "곡명" 같은 라벨이 함께 들어 있다. 그 요소의 제 텍스트만 읽는다.
      const title = $(".song_name").clone().children().remove().end().text().trim();
      // 트랙 ID를 직접 받은 경우는 부르는 쪽이 이미 고른 것이므로 제목을 따지지 않는다.
      if (!query.trackId && !sameTitle(title, query.title)) continue;

      const lyrics = htmlToPlainText($("#d_video_summary").html() ?? $(".lyric").html() ?? "");
      if (!lyrics) continue;

      const artist =
        $(".artist a")
          .first()
          .attr("title")
          ?.replace(/\s*-?\s*페이지 이동$/, "")
          .trim() ||
        $(".artist_name").text().trim() ||
        query.artist;
      const album = $(".meta dl dd").first().text().trim() || undefined;

      return { provider: "melon", title: title || query.title, artist, album, lyrics, url: detailUrl, trackId: songId };
    }
    return null;
  },
};
