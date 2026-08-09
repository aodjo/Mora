import assert from "node:assert/strict";
import test from "node:test";
import { appleMostPlayed, chartSeeds, melonTop100 } from "../Collector/src/charts.js";

// 실제 멜론 차트 HTML의 뼈대 — 프로브에서 확인한 구조 그대로.
const MELON_PAGE = `
<tr><td>
<div class="ellipsis rank01"><span><a href="javascript:melon.play(1);" title="LOVE ATTACK 재생">LOVE ATTACK</a></span></div>
<div class="ellipsis rank02"><a href="javascript:melon.link(2);" title="RESCENE">RESCENE (리센느)</a></div>
</td></tr>
<tr><td>
<div class="ellipsis rank01"><span><a href="javascript:melon.play(3);" title="갑자기 재생">갑자기 &amp; 다시</a></span></div>
<div class="ellipsis rank02"><a href="javascript:melon.link(4);" title="아이오아이">아이오아이 (I.O.I)</a></div>
</td></tr>`;

const APPLE_FEED = {
  feed: {
    results: [
      { name: "REDRED", artistName: "코르티스" },
      { name: "Brand New", artistName: "Mrs. GREEN APPLE" },
    ],
  },
};

test("the Melon chart is read in order with entities decoded", async () => {
  const fetcher = (async () => new Response(MELON_PAGE)) as typeof fetch;
  const seeds = await melonTop100(fetcher);
  assert.deepEqual(
    seeds.map((seed) => `${seed.artist} - ${seed.title}`),
    ["RESCENE (리센느) - LOVE ATTACK", "아이오아이 (I.O.I) - 갑자기 & 다시"],
  );
  // 1위가 2위보다 인기값이 높아야 순위가 우선순위가 된다.
  assert.ok(seeds[0]!.popularity > seeds[1]!.popularity);
  assert.equal(seeds[0]!.market, "KR");
});

test("a Melon page that stops looking like the chart is an error, not an empty run", async () => {
  const fetcher = (async () => new Response("<html>redesigned</html>")) as typeof fetch;
  await assert.rejects(() => melonTop100(fetcher), /MELON_CHART_EMPTY/u);
});

test("Apple's feed maps storefront by market", async () => {
  const asked: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    asked.push(String(input));
    return Response.json(APPLE_FEED);
  }) as typeof fetch;
  const seeds = await appleMostPlayed("JP", fetcher);
  assert.match(asked[0] ?? "", /\/v2\/jp\/music\/most-played\/100\/songs\.json$/u);
  assert.equal(seeds[0]?.market, "JP");
  assert.equal(seeds[0]?.artist, "코르티스");
});

test("KR asks its domestic chart as well; other markets only Apple", async () => {
  const asked: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    return url.includes("melon.com") ? new Response(MELON_PAGE) : Response.json(APPLE_FEED);
  }) as typeof fetch;
  const kr = await chartSeeds("KR", fetcher);
  assert.equal(asked.filter((url) => url.includes("melon.com")).length, 1);
  assert.equal(kr.length, 4);
  asked.length = 0;
  await chartSeeds("US", fetcher);
  assert.equal(asked.filter((url) => url.includes("melon.com")).length, 0);
});

test("one chart failing does not empty the market", async () => {
  const fetcher = (async (input: string | URL | Request) =>
    String(input).includes("melon.com") ? new Response("down", { status: 503 }) : Response.json(APPLE_FEED)) as typeof fetch;
  const seeds = await chartSeeds("KR", fetcher);
  assert.equal(seeds.length, 2);
});
