import assert from "node:assert/strict";
import test from "node:test";
import { searchYoutubeMusic, type YtEntry } from "../Collector/src/youtube.js";
import type { RecordingSeed } from "../Collector/src/types.js";

const URUMA: RecordingSeed = { artist: "uruma", title: "하치와레girl feat.pshine", popularity: 1, freshness: 0, market: "KR" };
const AESPA: RecordingSeed = { artist: "aespa", title: "Whiplash", popularity: 1, freshness: 0, market: "KR" };

/** 실제로 관찰한 응답 — 아티스트 본인 업로드가 1위다. */
const URUMA_UPLOAD: YtEntry[] = [
  { id: "abc12345678", title: "하치와레girl (feat. pshine)", duration: 146, channel: "uruma", uploader: "uruma" },
];
const WHIPLASH_AUDIO: YtEntry[] = [
  { id: "def12345678", title: "aespa (에스파) 'Whiplash' Official Audio", duration: 184, channel: "aespa", uploader: "aespa" },
];

test("a song the narrow query cannot see is asked for plainly", async () => {
  // 실측: "uruma 하치와레girl feat.pshine audio" 는 0건이고, audio 를 빼면 본인 업로드가 나온다.
  const asked: string[] = [];
  const found = await searchYoutubeMusic(URUMA, async (query) => {
    asked.push(query);
    return query.endsWith(" audio") ? [] : URUMA_UPLOAD;
  });
  assert.deepEqual(asked, ["uruma 하치와레girl feat.pshine audio", "uruma 하치와레girl feat.pshine"]);
  assert.equal(found.length, 1, "그냥 물으면 있는 곡이다");
  assert.equal(found[0]?.video_id, "abc12345678");
  assert.equal(found[0]?.source_type, "song", "아티스트 채널 업로드로 인식되어야 한다");
});

test("a song the narrow query can see is not asked twice", async () => {
  // "audio" 는 사람들이 찾는 곡에서 공식 음원을 위로 올린다 — 찾았으면 다시 묻지 않는다.
  const asked: string[] = [];
  const found = await searchYoutubeMusic(AESPA, async (query) => {
    asked.push(query);
    return WHIPLASH_AUDIO;
  });
  assert.deepEqual(asked, ["aespa Whiplash audio"]);
  assert.equal(found.length, 1);
});

test("both queries coming back empty is still an empty answer", async () => {
  const asked: string[] = [];
  const found = await searchYoutubeMusic(URUMA, async (query) => {
    asked.push(query);
    return [];
  });
  assert.equal(asked.length, 2);
  assert.deepEqual(found, []);
});
