import assert from "node:assert/strict";
import test from "node:test";
import { LyricFindCatalogue } from "../Collector/src/lyricfind.js";

// HAR로 관찰한 실제 응답 형태를 그대로 쓴다.
const SWIM = {
  titleSimple: "SWIM",
  title: "SWIM",
  duration: "2:39",
  isrcs: ["USA2P2600463", "USA2P2600449"],
  instrumental: false,
  artists: [{ name: "방탄소년단", nameRomanized: "BTS", is_primary: true }],
  artist: { name: "방탄소년단", nameRomanized: "BTS" },
};

function catalogue(tracks: unknown[]): { client: LyricFindCatalogue; asked: string[] } {
  const asked: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    asked.push(String(input));
    return Response.json({ response: { code: 100 }, tracks });
  }) as typeof fetch;
  return { client: new LyricFindCatalogue(fetcher), asked };
}

test("a romanized artist credit matches the seed's roman name", async () => {
  // 시드는 "BTS", LyricFind 표기는 방탄소년단 — nameRomanized가 잇는다.
  const { client } = catalogue([SWIM]);
  const found = await client.identify({ artist: "BTS", title: "SWIM", popularity: 1, freshness: 0, market: "KR" });
  assert.deepEqual(found, { isrc: "USA2P2600463", durationMs: 159_000 });
});

test("a similar but different song is not an answer", async () => {
  // 실측: "IU Love wins all" 검색은 Carrie Underwood "Love Wins"를 1위로 준다.
  const { client } = catalogue([
    { titleSimple: "Love Wins", duration: "3:49", isrcs: ["USUM71808325"], artists: [{ name: "Carrie Underwood" }] },
  ]);
  assert.equal(await client.identify({ artist: "IU", title: "Love wins all", popularity: 1, freshness: 0, market: "KR" }), undefined);
});

test("a matching row with nothing to give is passed over", async () => {
  // 같은 곡이 두 줄일 때(길이 없는 중복 항목이 흔하다) 정보가 있는 줄을 쓴다.
  const { client } = catalogue([{ ...SWIM, duration: undefined, isrcs: [] }, SWIM]);
  const found = await client.identify({ artist: "방탄소년단", title: "SWIM", popularity: 1, freshness: 0, market: "KR" });
  assert.deepEqual(found, { isrc: "USA2P2600463", durationMs: 159_000 });
});

test("the query carries both artist and title", async () => {
  const { client, asked } = catalogue([]);
  await client.identify({ artist: "Ado", title: "ギラギラ", popularity: 1, freshness: 0, market: "KR" });
  const url = new URL(asked[0] ?? "");
  assert.equal(url.searchParams.get("all"), "Ado ギラギラ");
  assert.equal(url.searchParams.get("searchtype"), "track");
});
