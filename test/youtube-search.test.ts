import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIsoDuration, searchYoutube } from "../Server/src/admin/youtube.js";

test("ISO 8601 durations parse to milliseconds", () => {
  assert.equal(parseIsoDuration("PT2M39S"), 159_000);
  assert.equal(parseIsoDuration("PT4M5S"), 245_000);
  assert.equal(parseIsoDuration("PT1H2M3S"), 3_723_000);
  assert.equal(parseIsoDuration("PT45S"), 45_000);
  assert.equal(parseIsoDuration("PT3M"), 180_000);
  // 라이브·프리미어는 길이가 없다.
  assert.equal(parseIsoDuration(undefined), 0);
  assert.equal(parseIsoDuration("P0D"), 0);
});

test("search joins the two calls the Data API needs and decodes titles", async () => {
  const asked: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    asked.push(url.pathname);
    if (url.pathname.endsWith("/search")) {
      assert.equal(url.searchParams.get("q"), "BTS SWIM");
      assert.equal(url.searchParams.get("type"), "video");
      return Response.json({
        items: [
          {
            id: { videoId: "G-z30uk_Xn4" },
            snippet: {
              title: "BTS &#39;SWIM&#39; Official Audio",
              channelTitle: "JXS_BP Official",
              publishedAt: "2026-08-01T00:00:00Z",
              thumbnails: { medium: { url: "https://i.ytimg.com/vi/G-z30uk_Xn4/mq.jpg" } },
            },
          },
          { id: {}, snippet: { title: "재생목록" } },
        ],
      });
    }
    assert.equal(url.searchParams.get("id"), "G-z30uk_Xn4");
    return Response.json({ items: [{ id: "G-z30uk_Xn4", contentDetails: { duration: "PT2M39S" } }] });
  }) as typeof fetch;

  const results = await searchYoutube("key", "BTS SWIM", fetcher);
  assert.deepEqual(asked, ["/youtube/v3/search", "/youtube/v3/videos"]);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    video_id: "G-z30uk_Xn4",
    title: "BTS 'SWIM' Official Audio",
    channel: "JXS_BP Official",
    duration_ms: 159_000,
    thumbnail: "https://i.ytimg.com/vi/G-z30uk_Xn4/mq.jpg",
    published_at: "2026-08-01T00:00:00Z",
  });
});

test("results survive a durations call that fails", async () => {
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith("/search"))
      return Response.json({ items: [{ id: { videoId: "abc" }, snippet: { title: "곡", channelTitle: "채널" } }] });
    return new Response("quota", { status: 403 });
  }) as typeof fetch;
  const results = await searchYoutube("key", "곡", fetcher);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.duration_ms, 0);
});

test("a quota rejection is reported as payment required, not a server fault", async () => {
  const fetcher = (async () => new Response("quota exceeded", { status: 403 })) as typeof fetch;
  await assert.rejects(() => searchYoutube("key", "곡", fetcher), /YOUTUBE_SEARCH_FAILED/u);
});
