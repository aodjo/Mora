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

// 실측: 차트는 "로제"라 부르고 LyricFind는 "로제 (ROSÉ)"라 적는다.
const TOXIC = {
  titleSimple: "toxic till the end",
  title: "toxic till the end",
  duration: "2:36",
  isrcs: ["USAT22409182"],
  artist: { name: "로제 (ROSÉ)", nameRomanized: "Rose" },
};

test("a name the catalogue decorated still answers to the name the chart used", async () => {
  const { client } = catalogue([TOXIC]);
  const found = await client.identify({ artist: "로제", title: "toxic till the end", popularity: 1, freshness: 0, market: "KR" });
  assert.deepEqual(found, { isrc: "USAT22409182", durationMs: 156_000 });
});

test("the alias inside the brackets answers too", async () => {
  const { client } = catalogue([TOXIC]);
  const found = await client.identify({ artist: "ROSÉ", title: "toxic till the end", popularity: 1, freshness: 0, market: "KR" });
  assert.equal(found?.isrc, "USAT22409182");
});

// 실측: 이 카탈로그는 제목에도 번역을 덧붙인다 — "좋은 날" → "좋은 날 Good Day".
const GOOD_DAY = {
  titleSimple: "좋은 날 Good Day",
  duration: "3:54",
  isrcs: ["KRA381001057"],
  artist: { name: "아이유(IU)" },
};

test("a title with its translation appended is still that song", async () => {
  const { client } = catalogue([GOOD_DAY]);
  const found = await client.identify({ artist: "아이유", title: "좋은 날", popularity: 1, freshness: 0, market: "KR" });
  assert.deepEqual(found, { isrc: "KRA381001057", durationMs: 234_000 });
});

test("a longer title that merely starts the same way is not that song", async () => {
  // 접두사만 보고 받아들이면 "좋은 날"이 "좋은 날들"에도 붙는다. 후보가 갈리면 물러난다.
  const { client } = catalogue([
    { titleSimple: "좋은 날 Good Day", duration: "3:54", isrcs: ["KRA381001057"], artist: { name: "아이유(IU)" } },
    { titleSimple: "좋은 날들 Good Days", duration: "4:10", isrcs: ["KRA381001099"], artist: { name: "아이유(IU)" } },
  ]);
  assert.equal(await client.identify({ artist: "아이유", title: "좋은 날", popularity: 1, freshness: 0, market: "KR" }), undefined);
});

test("a version of the song is never taken for the song", async () => {
  const { client } = catalogue([
    { titleSimple: "SWIM (Inst.)", duration: "2:39", isrcs: ["USA2P2600999"], artist: { name: "방탄소년단", nameRomanized: "BTS" } },
    { titleSimple: "SWIM Acoustic", duration: "2:44", isrcs: ["USA2P2600998"], artist: { name: "방탄소년단", nameRomanized: "BTS" } },
  ]);
  assert.equal(await client.identify({ artist: "BTS", title: "SWIM", popularity: 1, freshness: 0, market: "KR" }), undefined);
});

test("an exact title still wins over the decorated one beside it", async () => {
  const { client } = catalogue([
    GOOD_DAY,
    { titleSimple: "좋은 날", duration: "3:54", isrcs: ["KRA381001000"], artist: { name: "아이유(IU)" } },
  ]);
  const found = await client.identify({ artist: "아이유", title: "좋은 날", popularity: 1, freshness: 0, market: "KR" });
  assert.equal(found?.isrc, "KRA381001000");
});
