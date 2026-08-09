import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { startSearchServer } from "../Collector/src/search-server.js";
import type { YoutubeSearchResult } from "../Collector/src/youtube.js";

const asked: string[] = [];
const server = startSearchServer({
  origin: "https://mora.junx.dev",
  port: 0,
  search: async (query, limit): Promise<YoutubeSearchResult[]> => {
    asked.push(`${query}|${limit}`);
    if (query === "boom") throw new Error("yt-dlp exploded");
    return [
      { video_id: "G-z30uk_Xn4", title: "BTS 'SWIM' Official Audio", channel: "JXS_BP Official", duration_ms: 159_000, is_live: false },
    ];
  },
});
await new Promise((resolve) => server.once("listening", resolve));
const port = (server.address() as AddressInfo).port;
const call = (path: string, init?: RequestInit): Promise<Response> => fetch(`http://127.0.0.1:${port}${path}`, init);

after(() => server.close());

test("the console gets results without spending an API quota", async () => {
  const response = await call("/search?q=BTS%20SWIM&limit=6");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://mora.junx.dev");
  const body = (await response.json()) as { items: YoutubeSearchResult[] };
  assert.equal(body.items[0]?.video_id, "G-z30uk_Xn4");
  assert.deepEqual(asked, ["BTS SWIM|6"]);
});

test("a preflight is answered so the browser will make the call at all", async () => {
  const response = await call("/search?q=x", { method: "OPTIONS" });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://mora.junx.dev");
});

test("health says the Collector is up, which is what the console falls back on", async () => {
  assert.equal((await call("/health")).status, 200);
});

test("nothing but search is exposed", async () => {
  assert.equal((await call("/")).status, 404);
  assert.equal((await call("/search?q=x", { method: "POST" })).status, 405);
});

test("an empty or oversized query is refused before yt-dlp is started", async () => {
  const before = asked.length;
  assert.equal((await call("/search?q=%20%20")).status, 400);
  assert.equal((await call(`/search?q=${"a".repeat(201)}`)).status, 400);
  assert.equal(asked.length, before);
});

test("a failing search answers rather than hanging the console", async () => {
  const response = await call("/search?q=boom");
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "SEARCH_FAILED" });
});

test("the port is loopback only, so nothing off this machine can reach it", () => {
  assert.equal((server.address() as AddressInfo).address, "127.0.0.1");
});
