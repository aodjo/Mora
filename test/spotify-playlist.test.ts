import assert from "node:assert/strict";
import test from "node:test";
import { PUBLIC_MOST, playlistId, playlistTracks, publicPlaylist } from "../Server/src/admin/spotify.js";

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
  const found = await playlistTracks("abc", "t", spotify([{ items: [TRACK], next: null, total: 1 }]));
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
    "t",
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
  const found = await playlistTracks("abc", "t", spotify([page(100, "https://api.spotify.com/next"), page(50, null)]));
  assert.equal(found.tracks.length, 150);
});

test("a very long playlist stops at the limit rather than filling the basket", async () => {
  // 장바구니는 사람이 훑어볼 목록이다. 만 곡을 쏟으면 그 목적이 사라진다.
  const page = { items: Array.from({ length: 100 }, () => TRACK), next: "https://api.spotify.com/next", total: 5000 };
  const found = await playlistTracks("abc", "t", spotify(Array.from({ length: 60 }, () => page)), 250);
  assert.equal(found.tracks.length, 250);
});

test("a playlist that cannot be read says so", async () => {
  const hidden = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("accounts.spotify.com")) return Response.json({ access_token: "t" });
    if (url.includes("fields=name")) return new Response("no", { status: 404 });
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  await assert.rejects(() => playlistTracks("abc", "t", hidden), /SPOTIFY_PLAYLIST_404/u);
});

/** 붙임 화면 한 장. 진짜 것과 같은 자리에 곡 목록을 싣는다. */
function embedded(tracks: unknown[], name = "그만 살고 싶어"): typeof fetch {
  const data = { props: { pageProps: { state: { data: { entity: { name, trackList: tracks } } } } } };
  return (async () =>
    new Response(
      `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`,
    )) as typeof fetch;
}

test("a public playlist is read with nobody logged in", async () => {
  // 로그인 길은 스포티파이 대시보드에 사람을 등록해야 열린다. 공개 목록까지 거기 매여서는 안 된다.
  const found = await publicPlaylist(
    "abc",
    embedded([
      { title: "Here With Me", subtitle: "d4vd", duration: 242484 },
      { title: "낙사", subtitle: "Tsuku", duration: 169500 },
    ]),
  );
  assert.equal(found.name, "그만 살고 싶어");
  assert.deepEqual(
    found.tracks.map((one) => [one.artist, one.title, one.duration_ms]),
    [
      ["d4vd", "Here With Me", 242484],
      ["Tsuku", "낙사", 169500],
    ],
  );
  assert.equal(found.capped, false);
});

test("a public playlist that fills the page says it was cut short", async () => {
  // 150곡짜리를 받아 보면 정확히 100에서 끊긴다. 말 안 하면 나머지를 담은 줄 안다.
  const many = Array.from({ length: PUBLIC_MOST }, (_, k) => ({ title: `곡 ${k}`, subtitle: "누구", duration: 1000 }));
  assert.equal((await publicPlaylist("abc", embedded(many))).capped, true);
});

test("a public playlist skips rows we cannot make timings for", async () => {
  const found = await publicPlaylist(
    "abc",
    embedded([
      { title: "위잉위잉", subtitle: "혁오", duration: 1000 },
      { title: "", subtitle: "이름만", duration: 1000 },
      { title: "가수 없음", duration: 1000 },
    ]),
  );
  assert.equal(found.tracks.length, 1);
  assert.equal(found.total, 1);
});

test("a playlist that is not public leaves the embed empty", async () => {
  // 비공개 목록은 여기서 실패해야 로그인 길로 넘어간다.
  await assert.rejects(() => publicPlaylist("abc", embedded([])), /SPOTIFY_EMBED_EMPTY/u);
  await assert.rejects(
    () => publicPlaylist("abc", (async () => new Response("no", { status: 404 })) as typeof fetch),
    /SPOTIFY_EMBED_404/u,
  );
  await assert.rejects(
    () => publicPlaylist("abc", (async () => new Response("<html>빈 껍데기</html>")) as typeof fetch),
    /SPOTIFY_EMBED_EMPTY/u,
  );
});
