import assert from "node:assert/strict";
import test from "node:test";
import { hasNoLyricsToAlign, lyricsSearchInput, resolveDurationMs } from "../Collector/src/service.js";
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
