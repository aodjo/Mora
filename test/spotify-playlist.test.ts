import assert from "node:assert/strict";
import test from "node:test";
import { playlistId, playlistTracks } from "../Server/src/admin/spotify.js";

test("a playlist is recognised however it was pasted", () => {
  const wanted = "37i9dQZF1DXcBWIGoYBM5M";
  assert.equal(playlistId(`https://open.spotify.com/playlist/${wanted}`), wanted);
  // 공유 주소는 추적용 꼬리를 달고 온다.
  assert.equal(playlistId(`https://open.spotify.com/playlist/${wanted}?si=abc123&pt=x`), wanted);
  // 나라별 주소에는 앞에 지역이 붙는다.
  assert.equal(playlistId(`https://open.spotify.com/intl-ko/playlist/${wanted}`), wanted);
  assert.equal(playlistId(`spotify:playlist:${wanted}`), wanted);
  assert.equal(playlistId(`  ${wanted}  `), wanted);
});

test("something that is not a playlist is refused rather than guessed at", () => {
  // 앨범과 곡은 플레이리스트가 아니다. 식별자만 뽑아 쓰면 엉뚱한 것을 부르게 된다.
  assert.equal(playlistId("https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3"), undefined);
  assert.equal(playlistId("https://open.spotify.com/track/1Bb6jVrsg8cXxMCBxIWJUn"), undefined);
  assert.equal(playlistId("https://music.youtube.com/playlist?list=PL123"), undefined);
  assert.equal(playlistId(""), undefined);
  assert.equal(playlistId("좋은 노래 모음"), undefined);
});

/** 한 쪽씩 돌려주는 가짜 스포티파이. */
function spotify(pages: unknown[], name = "저녁에 듣는 것"): typeof fetch {
  let served = 0;
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("accounts.spotify.com")) return Response.json({ access_token: "t", expires_in: 3600 });
    if (url.includes("fields=name")) return Response.json({ name });
    const page = pages[served++] ?? { items: [], next: null, total: 0 };
    return Response.json(page);
  }) as typeof fetch;
}

const TRACK = {
  track: {
    name: "위잉위잉",
    duration_ms: 194_000,
    type: "track",
    artists: [{ name: "혁오" }],
    album: {
      name: "20",
      images: [
        { url: "https://i.test/big.jpg", width: 640 },
        { url: "https://i.test/small.jpg", width: 64 },
      ],
    },
    external_ids: { isrc: "KRA381502064" },
  },
};

test("a track arrives with the ISRC that says which recording it is", async () => {
  const found = await playlistTracks("abc", { id: "i", secret: "s" }, spotify([{ items: [TRACK], next: null, total: 1 }]));
  assert.equal(found.name, "저녁에 듣는 것");
  assert.equal(found.total, 1);
  assert.deepEqual(found.tracks, [
    {
      artist: "혁오",
      title: "위잉위잉",
      album: "20",
      duration_ms: 194_000,
      isrc: "KRA381502064",
      artwork: "https://i.test/big.jpg",
    },
  ]);
});

test("what is not a recording we can time is left behind", async () => {
  // 팟캐스트 에피소드, 사람이 올린 파일, 지워져서 빈 자리 — 셋 다 맞출 가사가 없다.
  const found = await playlistTracks(
    "abc",
    { id: "i", secret: "s" },
    spotify([
      {
        items: [
          TRACK,
          { track: { name: "어떤 에피소드", type: "episode", artists: [{ name: "누구" }] } },
          { track: { name: "내 파일", is_local: true, type: "track", artists: [{ name: "나" }] } },
          { track: null },
          { track: { name: "", type: "track", artists: [{ name: "이름만" }] } },
        ],
        next: null,
        total: 5,
      },
    ]),
  );
  assert.deepEqual(
    found.tracks.map((one) => one.title),
    ["위잉위잉"],
  );
  // 몇 곡을 지나쳤는지 셀 수 있어야 사람이 그 목록을 의심할 수 있다.
  assert.equal(found.total, 5);
});

test("a playlist longer than one page is followed to its end", async () => {
  const page = (n: number, next: string | null) => ({
    items: Array.from({ length: n }, (_, k) => ({
      track: { ...TRACK.track, name: `곡 ${k}`, external_ids: { isrc: `KR${k}` } },
    })),
    next,
    total: 150,
  });
  const found = await playlistTracks("abc", { id: "i", secret: "s" }, spotify([page(100, "https://api.spotify.com/next"), page(50, null)]));
  assert.equal(found.tracks.length, 150);
});

test("a very long playlist stops at the limit rather than filling the basket", async () => {
  // 장바구니는 사람이 훑어볼 목록이다. 만 곡을 쏟으면 그 목적이 사라진다.
  const page = { items: Array.from({ length: 100 }, () => TRACK), next: "https://api.spotify.com/next", total: 5000 };
  const found = await playlistTracks("abc", { id: "i", secret: "s" }, spotify(Array.from({ length: 60 }, () => page)), 250);
  assert.equal(found.tracks.length, 250);
});

test("credentials that are refused are told apart from a playlist that cannot be read", async () => {
  const refuses = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("accounts.spotify.com")) return new Response("no", { status: 401 });
    return Response.json({ items: [], next: null, total: 0 });
  }) as typeof fetch;
  await assert.rejects(() => playlistTracks("abc", { id: "i", secret: "s" }, refuses), /SPOTIFY_TOKEN_401/u);

  const hidden = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("accounts.spotify.com")) return Response.json({ access_token: "t" });
    if (url.includes("fields=name")) return new Response("no", { status: 404 });
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  await assert.rejects(() => playlistTracks("abc", { id: "i", secret: "s" }, hidden), /SPOTIFY_PLAYLIST_404/u);
});
