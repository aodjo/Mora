import assert from "node:assert/strict";
import test from "node:test";
import {
  CollectedIndex,
  canAutoSelect,
  hasNoLyricsToAlign,
  lyricsSearchInput,
  resolveDurationMs,
  reviewReason,
} from "../Collector/src/service.js";
import { SpotifyClient } from "../Collector/src/spotify.js";
import type { RecordingSeed, YoutubeCandidate } from "../Collector/src/types.js";

const seed: RecordingSeed = { artist: "Artist", title: "Song", popularity: 1, freshness: 0, market: "KR" };
const source: YoutubeCandidate = {
  url: "https://music.youtube.com/watch?v=abcdefghijk",
  video_id: "abcdefghijk",
  title: "Song",
  artist: "Artist",
  duration_ms: 183_400,
  official: true,
  source_type: "topic",
  score: 0.95,
};

test("Collector fills a missing recording duration from the selected media candidate", () => {
  assert.equal(resolveDurationMs(seed, [source]), 183_400);
});

test("Collector keeps an identified MusicBrainz duration", () => {
  assert.equal(resolveDurationMs({ ...seed, duration_ms: 181_234 }, [source]), 181_234);
  assert.equal(resolveDurationMs(seed, []), undefined);
});

test("Collector searches lyrics even before ISRC identification", () => {
  assert.deepEqual(lyricsSearchInput({ ...seed, mbid: "e139bd8d-410c-41c1-967c-a30ee3b444e8" }), {
    mbid: "e139bd8d-410c-41c1-967c-a30ee3b444e8",
    artist: "Artist",
    title: "Song",
  });
});

test("Collector drops tracks that announce they have no vocal", () => {
  // These reached the catalogue and then sat in review forever: nothing can time a track
  // that has no words, and the review screen has no action that resolves one.
  for (const title of [
    "Make up my mind (instrumental)",
    "그대이길 (inst.)",
    "Song (Inst)",
    "Ballad (Off Vocal)",
    "노래 (반주)",
    "Hit (Karaoke Version)",
    "노래 (MR)",
  ]) {
    assert.equal(hasNoLyricsToAlign({ ...seed, title }), true, title);
  }
  // A vocal track keeps its place, including one whose title merely contains the letters.
  for (const title of ["Song", "Instant Crush", "Ministry", "Mr. Blue Sky"]) {
    assert.equal(hasNoLyricsToAlign({ ...seed, title }), false, title);
  }
});

test("Spotify identification accepts only a track whose title and artist both agree", async () => {
  const track = (name: string, artist: string, isrc: string) => ({
    name,
    duration_ms: 188_000,
    artists: [{ name: artist }],
    album: { name: "Album" },
    external_ids: { isrc },
  });
  const client = (items: unknown[]) =>
    new SpotifyClient("id", "secret", (async (url: string | URL) =>
      String(url).includes("accounts.spotify.com")
        ? Response.json({ access_token: "t", expires_in: 3600 })
        : Response.json({ tracks: { items } })) as unknown as typeof fetch);

  const seed: RecordingSeed = { artist: "송하예", title: "그대이길", popularity: 1, freshness: 0, market: "KR" };
  // A same-titled song by someone else must not lend its ISRC: the identifier keys the public
  // row, so a wrong one mislabels every alignment published under it.
  assert.equal(await client([track("그대이길", "다른가수", "KRA111111111")]).identify(seed), undefined);
  assert.equal(await client([track("완전히 다른 곡", "송하예", "KRA222222222")]).identify(seed), undefined);
  assert.deepEqual(await client([track("그대이길", "송하예", "kra-333333333")]).identify(seed), {
    isrc: "KRA333333333",
    durationMs: 188_000,
    album: "Album",
  });
});

test("Review reasons name what is actually missing", () => {
  const candidate = { ...source, score: 0.86, official: false };
  // The two songs that kept reaching review with an ISRC and candidates: the shortlist simply
  // never cleared auto-selection, which the log could not say before.
  assert.equal(reviewReason(["source"], [candidate]), "자동 선택 기준 미달 (카탈로그 길이 없음, 아티스트 채널 아님)");
  assert.equal(reviewReason(["source"], [{ ...candidate, catalogue_drift_ms: 86_000 }]), "자동 선택 기준 미달 (길이 86.0초 차이)");
  assert.equal(reviewReason(["source"], [{ ...candidate, score: 0.7 }]), "자동 선택 기준 미달 (점수 0.70)");
  assert.equal(reviewReason(["source"], []), "음원 후보 없음");
  assert.equal(reviewReason(["isrc"], [candidate]), "ISRC 없음");
  assert.equal(reviewReason(["isrc", "source"], []), "ISRC 없음 · 음원 후보 없음");
});

test("the catalogue length decides auto-selection, not who uploaded the file", () => {
  // Measured against Spotify for the real uploads: 993ms, 467ms and 920ms out.
  const reupload: YoutubeCandidate = { ...source, official: false, score: 0.86, catalogue_drift_ms: 993 };
  assert.equal(canAutoSelect(reupload), true);

  // BTS' own channels hold a 4:05 music video for a 2:39 recording.
  assert.equal(canAutoSelect({ ...reupload, official: true, catalogue_drift_ms: 86_000 }), false);

  // Nothing authoritative answered, so ownership is all that is left to go on.
  assert.equal(canAutoSelect({ ...source, official: true, score: 0.86, catalogue_drift_ms: undefined }), true);
  assert.equal(canAutoSelect({ ...source, official: false, score: 0.86, catalogue_drift_ms: undefined }), false);

  // A weak title or artist match is disqualifying however well the length agrees.
  assert.equal(canAutoSelect({ ...reupload, score: 0.7 }), false);
  assert.equal(canAutoSelect(undefined), false);
});

test("a song already in the catalogue is skipped before anything is spent", () => {
  const index = new CollectedIndex([
    { artist: "BTS", title: "SWIM", isrc: "USA2P2600449" },
    { artist: "송하예", title: "그대이길" },
  ]);
  assert.equal(index.hasName({ ...seed, artist: "BTS", title: "SWIM" }), true);
  // 차트마다 표기가 흔들려도 정규화가 흡수한다.
  assert.equal(index.hasName({ ...seed, artist: "bts", title: "swim" }), true);
  assert.equal(index.hasName({ ...seed, artist: "BTS", title: "Come Over" }), false);

  // 이름이 달라도 식별이 끝나면 ISRC가 같은 녹음임을 알려준다.
  assert.equal(index.hasIsrc({ ...seed, artist: "방탄소년단", title: "SWIM", isrc: "usa2p2600449" }), true);
  assert.equal(index.hasIsrc({ ...seed, isrc: "KRA302600331" }), false);
  assert.equal(index.hasIsrc(seed), false);

  // ISRC가 없는 곡도 이름으로는 걸린다.
  assert.equal(index.hasName({ ...seed, artist: "송하예", title: "그대이길" }), true);
});

test("a song collected during the run is not collected twice", () => {
  const index = new CollectedIndex([]);
  const swim = { ...seed, artist: "BTS", title: "SWIM", isrc: "USA2P2600449" };
  assert.equal(index.hasName(swim), false);
  index.remember(swim);
  assert.equal(index.hasName(swim), true);
  assert.equal(index.hasIsrc({ ...seed, artist: "방탄소년단", title: "Swim", isrc: "USA2P2600449" }), true);
});

test("a Spotify rate limit stops the calls instead of hammering through the run", async () => {
  // 실측: 429 한 번에 retry-after 61159초(17시간). 계속 두드리면 차단이 연장된다.
  let searches = 0;
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("accounts.spotify.com")) return Response.json({ access_token: "t", expires_in: 3600 });
    searches++;
    return new Response("limited", { status: 429, headers: { "retry-after": "61159" } });
  }) as typeof fetch;
  const logged: string[] = [];
  const client = new SpotifyClient("id", "secret", fetcher, (message) => logged.push(message));

  await assert.rejects(() => client.identify({ artist: "BTS", title: "SWIM", popularity: 1, freshness: 0, market: "KR" }));
  assert.equal(searches, 1);
  assert.match(logged[0] ?? "", /시간 동안 Spotify 없이/u);
  assert.ok(client.blockedForMs > 60_000_000, String(client.blockedForMs));

  // 차단 중에는 요청 없이 즉시 물러난다 — 280곡이 429를 280번 만들지 않는다.
  for (let i = 0; i < 5; i++)
    assert.equal(await client.identify({ artist: "IU", title: "Love wins all", popularity: 1, freshness: 0, market: "KR" }), undefined);
  assert.equal(searches, 1);
});
