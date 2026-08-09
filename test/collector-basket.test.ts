import assert from "node:assert/strict";
import test from "node:test";
import { startBasketWorker } from "../Collector/src/basket-worker.js";
import type { RecordingSeed } from "../Collector/src/types.js";

function server(songs: Array<Record<string, unknown> | null>) {
  const answers: Array<{ id: string; error?: string }> = [];
  let claim = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/basket/claim")) return Response.json({ song: songs[claim++] ?? null });
    const id = url.slice(url.lastIndexOf("/") + 1);
    answers.push({ id, ...(JSON.parse(String(init?.body ?? "{}")) as { error?: string }) });
    return Response.json({ accepted: true });
  }) as typeof fetch;
  return { fetcher, answers };
}

const WHIPLASH = { id: "b1", artist: "aespa", title: "Whiplash", duration_ms: 183_000, isrc: "KRA302400341" };

test("a basket song is collected with what the console already knew about it", async () => {
  const { fetcher, answers } = server([WHIPLASH]);
  const seeds: RecordingSeed[] = [];
  const stop = startBasketWorker({
    adminUrl: "https://admin.test",
    adminToken: "t",
    fetch: fetcher,
    pollMs: 5,
    collect: async (seed) => {
      seeds.push(seed);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  stop();
  assert.equal(seeds[0]?.isrc, "KRA302400341");
  assert.equal(seeds[0]?.duration_ms, 183_000);
  // 사람이 이름을 대고 부른 곡이므로 차트가 넣은 어떤 곡보다 앞선다.
  assert.equal(seeds[0]?.popularity, 1);
  assert.deepEqual(answers[0], { id: "b1" });
});

test("a song that fails reports why instead of vanishing", async () => {
  const { fetcher, answers } = server([WHIPLASH]);
  const stop = startBasketWorker({
    adminUrl: "https://admin.test",
    adminToken: "t",
    fetch: fetcher,
    pollMs: 5,
    collect: async () => {
      throw new Error("DURATION_UNAVAILABLE");
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  stop();
  assert.deepEqual(answers[0], { id: "b1", error: "DURATION_UNAVAILABLE" });
});

test("an empty basket keeps waiting without spending anything", async () => {
  const { fetcher, answers } = server([null, null]);
  let collected = 0;
  const stop = startBasketWorker({
    adminUrl: "https://admin.test",
    adminToken: "t",
    fetch: fetcher,
    pollMs: 5,
    collect: async () => {
      collected++;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  stop();
  assert.equal(collected, 0);
  assert.deepEqual(answers, []);
});

test("a song only kept is never handed to a Collector", async () => {
  // 장바구니의 요점: 잘못 담은 곡을 내려받기 전에 뺄 수 있어야 한다. 담자마자 가져가면
  // 처리 버튼은 이미 끝난 일에 대고 누르는 버튼이 된다.
  const claimed: string[] = [];
  const basket = [
    { id: "b1", artist: "aespa", title: "Whiplash", state: "held" },
    { id: "b2", artist: "IU", title: "Love wins all", state: "released" },
  ];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/basket/claim")) {
      const next = basket.find((song) => song.state === "released");
      if (next === undefined) return Response.json({ song: null });
      next.state = "claimed";
      return Response.json({ song: { id: next.id, artist: next.artist, title: next.title } });
    }
    return Response.json({ accepted: true });
  }) as typeof fetch;
  const stop = startBasketWorker({
    adminUrl: "https://admin.test",
    adminToken: "t",
    fetch: fetcher,
    pollMs: 5,
    collect: async (seed) => {
      claimed.push(seed.title);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  stop();
  assert.deepEqual(claimed, ["Love wins all"], "넘긴 곡만 수집되어야 한다");
  assert.equal(basket[0]?.state, "held", "담아둔 곡은 그대로 있어야 한다");
});
