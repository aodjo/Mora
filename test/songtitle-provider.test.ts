import assert from "node:assert/strict";
import { test } from "node:test";
import { SongTitleLyricsProvider, inferLyricsLanguage } from "../Collector/src/songtitle-provider.js";
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

test("SongTitle adapter drops the notice a provider serves when it has no lyrics", async () => {
  // Verbatim from production: these landed as lyrics on 36, 35 and 7 recordings respectively.
  const router: SongTitleRouter = {
    async fetchAll(query) {
      return {
        query,
        results: [
          {
            provider: "bugs",
            lyrics: "가사 준비 중입니다.\n일반 가사 신청\n실시간 가사 신청\n벅스패널이 되면 가사를 등록하실 수 있습니다.",
          },
          { provider: "genie", lyrics: "가사 정보가 없습니다." },
          {
            provider: "bugs",
            lyrics: "청소년 보호법에 따라 19세 미만의 청소년이 이용할 수 없습니다.\n성인 인증 후 이용해 주세요. (연 1회)",
          },
          { provider: "flo", lyrics: "Swim, swim\nWater falling off your skin", title: "SWIM" },
        ],
        outcomes: [],
      };
    },
  };

  const result = await new SongTitleLyricsProvider(router).search({ artist: "BTS", title: "SWIM" });
  assert.deepEqual(
    result.map((item) => item.provider),
    ["flo"],
  );
});

test("SongTitle adapter drops lyrics a provider matched to a different song", async () => {
  // Melon answered one Latin lyric for 88 different HOYO-MiX recordings.
  const router: SongTitleRouter = {
    async fetchAll(query) {
      return {
        query,
        results: [
          { provider: "melon", lyrics: "A luna, cara cantica\nNe me in atra dedas", title: "Nocturne of Chains" },
          { provider: "genius", lyrics: "진짜 가사\n둘째 줄", title: "笼中遗事 (Bonus Track)" },
        ],
        outcomes: [],
      };
    },
  };

  const result = await new SongTitleLyricsProvider(router).search({ artist: "HOYO-MiX", title: "笼中遗事" });
  assert.deepEqual(
    result.map((item) => item.provider),
    ["genius"],
  );
});

test("a song whose own title reads like a notice is still collected", async () => {
  const router: SongTitleRouter = {
    async fetchAll(query) {
      return {
        query,
        results: [{ provider: "genius", lyrics: "Live forever\nI wanna live forever", title: "Live Forever" }],
        outcomes: [],
      };
    },
  };
  const result = await new SongTitleLyricsProvider(router).search({ artist: "Oasis", title: "Live Forever" });
  assert.equal(result.length, 1);
});
