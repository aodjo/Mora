import assert from "node:assert/strict";
import { test } from "node:test";
import { comparable, pickTrack, sameArtist, sameTitle } from "../packages/songtitle/src/util/match.js";
import { genie } from "../packages/songtitle/src/providers/genie.js";
import { vibe } from "../packages/songtitle/src/providers/vibe.js";
import { flo } from "../packages/songtitle/src/providers/flo.js";
import { bugs } from "../packages/songtitle/src/providers/bugs.js";
import { melon } from "../packages/songtitle/src/providers/melon.js";
import type { ProviderContext } from "../packages/songtitle/src/types.js";

/** URL 접두사 → 응답 본문. 등록되지 않은 URL 요청은 그 자체가 테스트 실패다. */
function fakeFetch(routes: Record<string, string>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const [prefix, body] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return new Response(body, { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
}

function ctx(routes: Record<string, string>): ProviderContext {
  return { keys: {}, timeoutMs: 5_000, fetchImpl: fakeFetch(routes) };
}

test("title and artist matching absorbs feat-suffixes and dual-script credits", () => {
  assert.equal(sameTitle("그대이길 ", "그대이길"), true);
  assert.equal(sameTitle("그대이길 (Feat. 신용재)", "그대이길"), true);
  assert.equal(sameTitle("Window (Feat. Domo Genesis & Frank Ocean & Hodgy Beats & Mike G)", "The Wolf Is Coming"), false);
  assert.equal(sameArtist("아이유(IU)", "IU"), true);
  assert.equal(sameArtist("Tyler, The Creator", "HOYO-MiX"), false);
  assert.equal(comparable("Love wins all"), comparable("love wins all"));
});

test("pickTrack prefers the artist match among same-titled candidates and rejects on title", () => {
  const items = [
    { title: "그대이길", artist: "김철수" },
    { title: "그대이길", artist: "송하예" },
  ];
  assert.equal(pickTrack(items, { title: "그대이길", artist: "송하예" }, (i) => i)?.artist, "송하예");
  // 아티스트 표기가 달라 확인이 안 되면 검색 순위(첫 제목 일치)를 따른다.
  assert.equal(pickTrack(items, { title: "그대이길", artist: "Song Ha Yea" }, (i) => i)?.artist, "김철수");
  assert.equal(
    pickTrack(items, { title: "다른 곡", artist: "송하예" }, (i) => i),
    undefined,
  );
});

/** genie 검색 HTML: 실제 사고 사례 — HOYO-MiX 질의에 Tyler, The Creator 행이 1위였다. */
const GENIE_ROW = (songId: string, title: string, artist: string) => `
  <tr class="list" songid="${songId}">
    <td class="info">
      <a href="#" class="title ellipsis" title="${title}"><span class="icon icon-title">TITLE</span> ${title}</a>
      <a href="#" class="artist ellipsis">${artist}</a>
      <a href="#" class="albumtitle ellipsis">앨범</a>
    </td>
  </tr>`;

test("genie rejects a search whose rows are all different songs", async () => {
  const routes = {
    "https://www.genie.co.kr/search/searchMain": `<table><tbody>${GENIE_ROW("81012822", "Window (Feat. Domo Genesis & Frank Ocean & Hodgy Beats & Mike G)", "Tyler, The Creator")}</tbody></table>`,
  };
  assert.equal(await genie.fetch({ title: "The Wolf Is Coming", artist: "HOYO-MiX" }, ctx(routes)), null);
});

test("genie picks the matching row and reports its real identity", async () => {
  const routes = {
    "https://www.genie.co.kr/search/searchMain": `<table><tbody>
      ${GENIE_ROW("111", "다른 노래", "다른 가수")}
      ${GENIE_ROW("116045648", "그대이길", "송하예")}
    </tbody></table>`,
    "https://dn.genie.co.kr/app/purchase/get_msl.asp": `callback({"400":"꼭 감은 그대 눈 위에","5200":"나의 입을 맞추며"})`,
  };
  const result = await genie.fetch({ title: "그대이길", artist: "송하예" }, ctx(routes));
  assert.equal(result?.trackId, "116045648");
  assert.equal(result?.title, "그대이길");
  assert.equal(result?.artist, "송하예");
  assert.match(result?.lyrics ?? "", /꼭 감은 그대 눈 위에/u);
});

test("vibe picks the matching track instead of the first and reports its real identity", async () => {
  const routes = {
    "https://apis.naver.com/vibeWeb/musicapiweb/v3/search/track": JSON.stringify({
      response: {
        result: {
          tracks: [
            { trackId: 1, trackTitle: "완전 다른 곡", artists: [{ artistName: "누군가" }] },
            { trackId: 106302307, trackTitle: "그대이길", artists: [{ artistName: "송하예" }], album: { albumTitle: "그대이길 X 사랑" } },
          ],
        },
      },
    }),
    "https://apis.naver.com/vibeWeb/musicapiweb/v3/lyric/106302307": JSON.stringify({
      response: { result: { lyric: { normalLyric: { text: "꼭 감은 그대 눈 위에" } } } },
    }),
  };
  const result = await vibe.fetch({ title: "그대이길", artist: "송하예" }, ctx(routes));
  assert.equal(result?.trackId, "106302307");
  assert.equal(result?.title, "그대이길");
  assert.equal(result?.artist, "송하예");
  assert.equal(result?.album, "그대이길 X 사랑");
});

test("vibe returns nothing when no track shares the title", async () => {
  const routes = {
    "https://apis.naver.com/vibeWeb/musicapiweb/v3/search/track": JSON.stringify({
      response: { result: { tracks: [{ trackId: 9, trackTitle: "Window", artists: [{ artistName: "Tyler, The Creator" }] }] } },
    }),
  };
  assert.equal(await vibe.fetch({ title: "The Wolf Is Coming", artist: "HOYO-MiX" }, ctx(routes)), null);
});

test("flo picks the matching track from the TRACK group", async () => {
  const routes = {
    "https://www.music-flo.com/api/search/v2/search": JSON.stringify({
      data: {
        list: [
          {
            type: "TRACK",
            list: [
              { id: 1, name: "엉뚱한 곡", artistList: [{ name: "남" }] },
              { id: 599171494, name: "그대이길", artistList: [{ name: "송하예" }] },
            ],
          },
        ],
      },
    }),
    "https://www.music-flo.com/api/meta/v1/track/599171494": JSON.stringify({
      data: { name: "그대이길", lyrics: "꼭 감은 그대 눈 위에\n나의 입을 맞추며" },
    }),
  };
  const result = await flo.fetch({ title: "그대이길", artist: "송하예" }, ctx(routes));
  assert.equal(result?.trackId, "599171494");
  assert.equal(result?.artist, "송하예");
});

test("bugs picks the matching row before scraping the track page", async () => {
  const routes = {
    "https://music.bugs.co.kr/search/track": `<table><tbody>
      <tr trackId="1" rowType="track"><th><p class="title"><a title="엉뚱한 곡">엉뚱한 곡</a></p></th><td><p class="artist"><a>남</a></p></td></tr>
      <tr trackId="34014208" rowType="track"><th><p class="title"><a title="그대이길">그대이길</a></p></th><td><p class="artist"><a>송하예</a></p></td></tr>
    </tbody></table>`,
    "https://music.bugs.co.kr/track/34014208": `<header class="pgTitle"><h1>그대이길</h1></header>
      <div class="basicInfo"><a href="/artist/80151950">송하예</a></div>
      <div class="lyricsContainer"><xmp>꼭 감은 그대 눈 위에</xmp></div>`,
  };
  const result = await bugs.fetch({ title: "그대이길", artist: "송하예" }, ctx(routes));
  assert.equal(result?.trackId, "34014208");
  assert.equal(result?.title, "그대이길");
});

test("melon rejects a search whose rows are all different songs", async () => {
  const routes = {
    "https://www.melon.com/search/total/index.htm": `<table><tbody><tr>
      <td><a href="javascript:melon.link.goSongDetail('42');" class="btn"><span>다른 곡 상세정보 페이지 이동</span></a>
      <a href="javascript:melon.play.playSong('x',42);" title="다른 곡">다른 곡</a></td>
      <td><div class="wrapArtistName"><a>남</a></div></td>
    </tr></tbody></table>`,
  };
  assert.equal(await melon.fetch({ title: "The Wolf Is Coming", artist: "HOYO-MiX" }, ctx(routes)), null);
});

test("melon picks the row whose title matches", async () => {
  const routes = {
    "https://www.melon.com/search/total/index.htm": `<table><tbody>
      <tr><td><a href="javascript:melon.link.goSongDetail('42');"><span>x</span></a><a href="javascript:melon.play.playSong('a',42);" title="다른 곡">다른 곡</a></td><td><div class="wrapArtistName"><a>남</a></div></td></tr>
      <tr><td><a href="javascript:melon.link.goSongDetail('602665433');"><span>x</span></a><a href="javascript:melon.play.playSong('b',602665433);" title="그대이길">그대이길</a></td><td><div class="wrapArtistName"><a>송하예</a></div></td></tr>
    </tbody></table>`,
    "https://www.melon.com/song/detail.htm": `<div class="song_name">그대이길</div>
      <div class="artist"><a title="송하예 - 페이지 이동">송하예</a></div>
      <div id="d_video_summary">꼭 감은 그대 눈 위에<br>나의 입을 맞추며</div>`,
  };
  const result = await melon.fetch({ title: "그대이길", artist: "송하예" }, ctx(routes));
  assert.equal(result?.trackId, "602665433");
  assert.equal(result?.artist, "송하예");
});

test("an exact title beats an earlier containment match", () => {
  // 실측: melon·flo 모두 "SWIM BTS" 검색 1위가 "I Swim How Bts"(Lil Barberi)였고
  // 진짜 "SWIM"(방탄소년단, 정확 일치)은 그 아래였다.
  const items = [
    { title: "I Swim How Bts", artist: "Lil Barberi" },
    { title: "SWIM (Cover) [Originally Performed by BTS]", artist: "Mobile Melody Series" },
    { title: "SWIM", artist: "방탄소년단" },
  ];
  assert.equal(pickTrack(items, { title: "SWIM", artist: "BTS" }, (i) => i)?.artist, "방탄소년단");
  // 아티스트까지 일치하면 정확 제목이 같아도 그쪽이 이긴다.
  const twoExact = [
    { title: "SWIM", artist: "다른가수" },
    { title: "SWIM", artist: "BTS" },
  ];
  assert.equal(pickTrack(twoExact, { title: "SWIM", artist: "BTS" }, (i) => i)?.artist, "BTS");
});

test("genie drops the title header its detail page prepends", async () => {
  // 실측: Oasis는 JSONP(싱크)가 없어 스크랩 경로로 떨어지고, 그 본문이
  // "Half The World Away - Oasis"로 시작한다 — 부르지 않는 줄이라 정렬이 밀린다.
  const routes = {
    "https://www.genie.co.kr/search/searchMain": `<table><tbody>${GENIE_ROW("16680567", "Half The World Away", "Oasis")}</tbody></table>`,
    "https://dn.genie.co.kr/app/purchase/get_msl.asp": "not json",
    "https://www.genie.co.kr/detail/songInfo": `<div id="pLyrics"><p>Half The World Away - Oasis<br>I would like to leave this city<br>This old town don't smell too pretty</p></div>`,
  };
  const result = await genie.fetch({ title: "Half the World Away", artist: "Oasis" }, ctx(routes));
  assert.equal(result?.lyrics.split("\n")[0], "I would like to leave this city");
});

test("genie keeps a first line that merely resembles the title", async () => {
  const routes = {
    "https://www.genie.co.kr/search/searchMain": `<table><tbody>${GENIE_ROW("1", "Swim", "BTS")}</tbody></table>`,
    "https://dn.genie.co.kr/app/purchase/get_msl.asp": "not json",
    "https://www.genie.co.kr/detail/songInfo": `<div id="pLyrics"><p>Swim, swim<br>Water falling off your skin</p></div>`,
  };
  const result = await genie.fetch({ title: "Swim", artist: "BTS" }, ctx(routes));
  assert.equal(result?.lyrics.split("\n")[0], "Swim, swim");
});

test("genie drops the title header its synced lyrics carry at 0ms", async () => {
  // 실측: Oasis "Half the World Away"의 get_msl.asp 첫 줄이 0ms에 "Half The World Away - Oasis".
  const routes = {
    "https://www.genie.co.kr/search/searchMain": `<table><tbody>${GENIE_ROW("16680567", "Half The World Away", "Oasis")}</tbody></table>`,
    "https://dn.genie.co.kr/app/purchase/get_msl.asp": `cb({"0":"Half The World Away - Oasis ","8900":"I would like to leave this city","13500":"This old town don't smell too pretty"})`,
  };
  const result = await genie.fetch({ title: "Half the World Away", artist: "Oasis" }, ctx(routes));
  assert.equal(result?.lyrics.split("\n")[0], "I would like to leave this city");
  assert.equal(result?.synced?.[0]?.timeMs, 8900);
  assert.equal(result?.synced?.length, 2);
});
