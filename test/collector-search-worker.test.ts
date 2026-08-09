import assert from "node:assert/strict";
import { test } from "node:test";
import { startSearchWorker } from "../Collector/src/search-worker.js";
import type { YoutubeSearchResult } from "../Collector/src/youtube.js";

const HIT: YoutubeSearchResult = {
  video_id: "G-z30uk_Xn4",
  title: "BTS 'SWIM' Official Audio",
  channel: "JXS_BP Official",
  duration_ms: 159_000,
  is_live: false,
};

/** Stands in for the queue: hands out the given requests once each, and records the answers. */
function server(queue: Array<{ id: string; query: string }>) {
  const answers = new Map<string, Record<string, unknown>>();
  const claims: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/admin/api/collector/searches/claim")) {
      claims.push("claim");
      return Response.json({ request: queue.shift() ?? null });
    }
    const id = url.slice(url.lastIndexOf("/") + 1);
    answers.set(decodeURIComponent(id), JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ accepted: true });
  }) as typeof fetch;
  return { fetchImpl, answers, claims };
}

async function settle(check: () => boolean, budgetMs = 2_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline && !check()) await new Promise((resolve) => setTimeout(resolve, 10));
}

test("a claimed query is searched and answered", async () => {
  const { fetchImpl, answers } = server([{ id: "req-1", query: "BTS SWIM" }]);
  const asked: string[] = [];
  const stop = startSearchWorker({
    adminUrl: "https://admin.test",
    adminToken: "token",
    fetch: fetchImpl,
    pollMs: 10,
    search: async (query) => {
      asked.push(query);
      return [HIT];
    },
  });
  await settle(() => answers.has("req-1"));
  stop();
  assert.deepEqual(asked, ["BTS SWIM"]);
  assert.deepEqual(answers.get("req-1"), { items: [HIT] });
});

test("a failing search reports the failure instead of leaving the console waiting", async () => {
  const { fetchImpl, answers } = server([{ id: "req-2", query: "boom" }]);
  const stop = startSearchWorker({
    adminUrl: "https://admin.test",
    adminToken: "token",
    fetch: fetchImpl,
    pollMs: 10,
    search: async () => {
      throw new Error("YTDLP_FAILED");
    },
  });
  await settle(() => answers.has("req-2"));
  stop();
  assert.deepEqual(answers.get("req-2"), { error: "YTDLP_FAILED" });
});

test("an empty queue is polled without answering anything", async () => {
  const { fetchImpl, answers, claims } = server([]);
  const stop = startSearchWorker({ adminUrl: "https://admin.test", adminToken: "token", fetch: fetchImpl, pollMs: 10 });
  await settle(() => claims.length >= 3);
  stop();
  assert.equal(answers.size, 0);
  assert.ok(claims.length >= 3, `폴링이 계속되어야 한다 (${claims.length}회)`);
});

test("stopping ends the polling", async () => {
  const { fetchImpl, claims } = server([]);
  const stop = startSearchWorker({ adminUrl: "https://admin.test", adminToken: "token", fetch: fetchImpl, pollMs: 10 });
  await settle(() => claims.length >= 2);
  stop();
  const seen = claims.length;
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(claims.length <= seen + 1, `중단 후에도 폴링이 이어졌다 (${seen} → ${claims.length})`);
});

test("a server that refuses does not become a hot loop", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response("nope", { status: 403 });
  }) as typeof fetch;
  const logged: string[] = [];
  const stop = startSearchWorker({
    adminUrl: "https://admin.test",
    adminToken: "token",
    fetch: fetchImpl,
    pollMs: 10,
    onLog: (message) => logged.push(message),
  });
  await settle(() => logged.length > 0);
  const afterFailure = calls;
  await new Promise((resolve) => setTimeout(resolve, 150));
  stop();
  assert.match(logged[0] ?? "", /CLAIM_403/u);
  assert.equal(calls, afterFailure, "실패 뒤에는 물러나 기다려야 한다");
});
