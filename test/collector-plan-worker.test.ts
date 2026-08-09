import assert from "node:assert/strict";
import test from "node:test";
import { startPlanWorker, type CollectionWork } from "../Collector/src/plan-worker.js";
import type { RecordingSeed } from "../Collector/src/types.js";

/** 서버가 하나뿐인 대기열을 쥐고, Collector들이 거기서 한 곡씩 집어가는 상황을 재현한다. */
function server(target: number, chart: Array<{ artist: string; title: string }>) {
  const queue = chart.map((song, index) => ({ ...song, id: `q${index}`, state: "pending" as string, claimedBy: "" }));
  const filled = { done: false };
  const discoveries: number[] = [];
  const leases = new Set<string>();
  const make = (who: string): typeof fetch =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/work/claim")) {
        const next = queue.find((song) => song.state === "pending");
        if (next !== undefined) {
          next.state = "claimed";
          next.claimedBy = who;
          return Response.json({ work: { kind: "collect", id: next.id, artist: next.artist, title: next.title, market: "KR" } });
        }
        if (filled.done || leases.size > 0) return Response.json({ work: { kind: "idle" } });
        leases.add(who);
        return Response.json({ work: { kind: "discover", want: target } });
      }
      if (url.endsWith("/work/fill")) {
        const body = JSON.parse(String(init?.body)) as { songs: Array<{ artist: string; title: string }> };
        discoveries.push(body.songs.length);
        filled.done = true;
        leases.clear();
        return Response.json({ queued: body.songs.length });
      }
      const id = url.slice(url.lastIndexOf("/") + 1);
      const song = queue.find((entry) => entry.id === id);
      if (song !== undefined) song.state = JSON.parse(String(init?.body ?? "{}")).error === undefined ? "done" : "failed";
      return Response.json({ accepted: true });
    }) as typeof fetch;
  return { queue, discoveries, make };
}

const CHART = [
  { artist: "aespa", title: "Whiplash" },
  { artist: "IU", title: "Love wins all" },
  { artist: "BTS", title: "SWIM" },
];

test("several Collectors share one queue and each song is collected once", async () => {
  const { queue, make } = server(3, CHART);
  const taken: Record<string, string[]> = { A: [], B: [], C: [] };
  const stops = ["A", "B", "C"].map((who) =>
    startPlanWorker({
      adminUrl: "https://admin.test",
      adminToken: "t",
      fetch: make(who),
      pollMs: 5,
      discover: async () => [],
      collect: async (seed: RecordingSeed) => {
        taken[who]!.push(`${seed.artist} - ${seed.title}`);
        await new Promise((resolve) => setTimeout(resolve, 15));
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  stops.forEach((stop) => stop());

  const all = [...taken.A!, ...taken.B!, ...taken.C!];
  assert.equal(all.length, 3, "곡 수만큼만 수집되어야 한다");
  assert.equal(new Set(all).size, 3, "같은 곡을 두 대가 가져가면 안 된다");
  assert.ok(queue.every((song) => song.state === "done"));
});

test("only the Collector holding the lease walks the charts", async () => {
  // 대기열이 비어 있으면 채워야 하지만, 세 대가 각자 차트를 훑으면 같은 일을 세 번 한다.
  const { discoveries, make } = server(5, []);
  let walked = 0;
  const stops = ["A", "B", "C"].map((who) =>
    startPlanWorker({
      adminUrl: "https://admin.test",
      adminToken: "t",
      fetch: make(who),
      pollMs: 5,
      discover: async (want) => {
        walked++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return CHART.slice(0, want).map((song) => ({ ...song, popularity: 1, freshness: 0, market: "KR" as const }));
      },
      collect: async () => undefined,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  stops.forEach((stop) => stop());
  assert.equal(walked, 1, "차트는 한 번만 훑어야 한다");
  assert.deepEqual(discoveries, [3]);
});

test("a song that fails comes back as failed rather than disappearing", async () => {
  const { queue, make } = server(1, [{ artist: "Megasound", title: "Keep On Running" }]);
  const stop = startPlanWorker({
    adminUrl: "https://admin.test",
    adminToken: "t",
    fetch: make("A"),
    pollMs: 5,
    discover: async () => [],
    collect: async () => {
      throw new Error("DURATION_UNAVAILABLE");
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  stop();
  assert.equal(queue[0]?.state, "failed");
});

test("an idle queue is not a busy loop", async () => {
  let claims = 0;
  const fetcher = (async (input: string | URL | Request) => {
    if (String(input).endsWith("/work/claim")) claims++;
    return Response.json({ work: { kind: "idle" } as CollectionWork });
  }) as typeof fetch;
  const stop = startPlanWorker({
    adminUrl: "https://admin.test",
    adminToken: "t",
    fetch: fetcher,
    pollMs: 30,
    discover: async () => [],
    collect: async () => undefined,
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  stop();
  assert.ok(claims <= 6, `대기 중에는 천천히 물어야 한다 (${claims}회)`);
});
