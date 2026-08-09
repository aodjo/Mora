import assert from "node:assert/strict";
import test from "node:test";
import { merge, searchGenie, searchMelon, searchVibe, type SongHit } from "../Collector/src/song-search.js";

// 실제 응답에서 확인한 구조를 축소한 것.
const MELON_PAGE = `
<a href="javascript:melon.play.playSong('26','1');" class="fc_gray" title="Whiplash">Whiplash</a>
<a href="javascript:melon.link.goArtistDetail('123');" title="aespa" class="fc_mgray">aespa</a>
<a href="javascript:melon.link.goAlbumDetail('456');" title="Whiplash" class="fc_mgray">Whiplash - The 5th Mini Album</a>`;

const GENIE_PAGE = `<tr class="list" songid="1">
<a href="#" class="title ellipsis" title="Whiplash"><span class="icon icon-title">TITLE</span> Whiplash </a>
<a href="#" class="artist ellipsis">aespa</a>
<a href="#" class="albumtitle ellipsis">Whiplash - The 5th Mini Album</a></tr>`;

test("Melon's row gives up title, artist and album", async () => {
  const hits = await searchMelon("aespa", (async () => new Response(MELON_PAGE)) as typeof fetch);
  assert.deepEqual(hits, [{ provider: "melon", title: "Whiplash", artist: "aespa", album: "Whiplash - The 5th Mini Album" }]);
});

test("Genie's TITLE badge is not part of the song's name", async () => {
  // 배지를 안 걷어내면 제목이 "TITLE HOT --> Whiplash"가 되어 다른 서비스와 합쳐지지 않는다.
  const hits = await searchGenie("aespa", (async () => new Response(GENIE_PAGE)) as typeof fetch);
  assert.equal(hits[0]?.title, "Whiplash");
});

test("Vibe's several credited artists read as one line", async () => {
  const payload = {
    response: {
      result: {
        tracks: [
          {
            trackTitle: "Whiplash",
            playTime: 183,
            artists: [{ artistName: "aespa" }, { artistName: "카리나" }],
            album: { albumTitle: "Whiplash", imageUrl: "https://example.test/a.jpg" },
          },
        ],
      },
    },
  };
  const hits = await searchVibe("aespa", (async () => Response.json(payload)) as typeof fetch);
  assert.equal(hits[0]?.artist, "aespa, 카리나");
  assert.equal(hits[0]?.duration_ms, 183_000);
  assert.equal(hits[0]?.artwork, "https://example.test/a.jpg");
});

test("one song on four services is one row wearing four badges", () => {
  const found: SongHit[] = [
    { provider: "melon", artist: "아이유 (IU)", title: "좋은 날" },
    { provider: "genie", artist: "아이유(IU)", title: "좋은 날", album: "REAL" },
    { provider: "vibe", artist: "아이유 (IU)", title: "좋은날", duration_ms: 234_000 },
    { provider: "lyricfind", artist: "아이유(IU)", title: "좋은 날", isrc: "KRA381000123" },
  ];
  const merged = merge(found);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]?.providers, ["melon", "genie", "vibe", "lyricfind"]);
  // 각 서비스가 가진 조각이 하나로 모인다.
  assert.equal(merged[0]?.album, "REAL");
  assert.equal(merged[0]?.duration_ms, 234_000);
  assert.equal(merged[0]?.isrc, "KRA381000123");
});

test("an instrumental cut is not merged into the song it belongs to", () => {
  const merged = merge([
    { provider: "melon", artist: "아이유", title: "좋은 날" },
    { provider: "melon", artist: "아이유", title: "좋은 날 (Inst.)" },
  ]);
  assert.equal(merged.length, 2);
});

test("more services carrying it means higher in the list", () => {
  const merged = merge([
    { provider: "melon", artist: "무명", title: "한 곳에만" },
    { provider: "melon", artist: "유명", title: "여러 곳에" },
    { provider: "genie", artist: "유명", title: "여러 곳에" },
  ]);
  assert.equal(merged[0]?.title, "여러 곳에");
});
