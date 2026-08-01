import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SongTitleLyricsProvider,
  inferLyricsLanguage,
} from "../Collector/src/songtitle-provider.js";
import type { SongTitleRouter } from "../Collector/src/songtitle-provider.js";

test("SongTitle adapter preserves every non-empty provider result", async () => {
  const router: SongTitleRouter = {
    async fetchAll(query) {
      assert.deepEqual(query, { title: "노래", artist: "가수" });
      return {
        query,
        results: [
          { provider: "melon", lyrics: "그대로 둔 원문\n둘째 줄", url: "https://example.test/song/1" },
          { provider: "genie", lyrics: "English lyrics", trackId: "42" },
          { provider: "empty", lyrics: "  " },
        ],
        outcomes: [],
      };
    },
  };

  const result = await new SongTitleLyricsProvider(router).search({
    isrc: "KRA000000001",
    artist: "가수",
    title: "노래",
  });

  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    provider: "melon",
    provider_ref: "https://example.test/song/1",
    text: "그대로 둔 원문\n둘째 줄",
    language: "ko",
    fetched_at: result[0]?.fetched_at,
  });
  assert.equal(result[1]?.provider_ref, "genie:42");
  assert.equal(result[1]?.language, "en");
});

test("language inference is conservative for supported markets", () => {
  assert.equal(inferLyricsLanguage("안녕 hello"), "ko");
  assert.equal(inferLyricsLanguage("君の名前を呼ぶ"), "ja");
  assert.equal(inferLyricsLanguage("Hello world"), "en");
  assert.equal(inferLyricsLanguage("你好世界"), undefined);
});
