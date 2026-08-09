import assert from "node:assert/strict";
import { test } from "node:test";
import { CollectorService } from "../Collector/src/service.js";
import type { CollectorProgress, RecordingSeed, YoutubeCandidate } from "../Collector/src/types.js";

const SWIM: RecordingSeed = { artist: "BTS", title: "SWIM", duration_ms: 159_000, popularity: 1, freshness: 0, market: "KR" };
const GEUDAE: RecordingSeed = { artist: "송하예", title: "그대이길", duration_ms: 188_000, popularity: 0.9, freshness: 0, market: "KR" };

/**
 * The point of the skip is that it happens before anything is spent, so the harness counts what
 * the expensive stages were asked to do rather than only what came out the other end.
 */
function harness(collected: Array<{ artist: string; title: string; isrc?: string }>) {
  const searched: string[] = [];
  const lyricsFor: string[] = [];
  const submitted: string[] = [];
  const progress: CollectorProgress[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/admin/api/collector/collected")) return Response.json({ recordings: collected });
    if (url.endsWith("/admin/api/collector/recordings")) {
      const sent = JSON.parse(String(init?.body)) as { recording: { artist: string; title: string } };
      submitted.push(`${sent.recording.artist} - ${sent.recording.title}`);
      return Response.json({ job_id: "job-1", deduplicated: false });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const service = new CollectorService({
    adminUrl: "https://admin.test",
    adminToken: "token",
    userAgent: "test",
    dailyBudget: 10,
    markets: ["KR"],
    fetch: fetchImpl,
    youtubeSearch: async (seed): Promise<YoutubeCandidate[]> => {
      searched.push(`${seed.artist} - ${seed.title}`);
      return [
        {
          url: "https://music.youtube.com/watch?v=abcdefghijk",
          video_id: "abcdefghijk",
          title: seed.title,
          artist: seed.artist,
          duration_ms: 180_000,
          official: true,
          source_type: "song",
          score: 0.95,
        },
      ];
    },
    lyricsProvider: {
      search: async (input) => {
        lyricsFor.push(`${input.artist} - ${input.title}`);
        return [{ provider: "test", text: "가사 한 줄", fetched_at: Date.now() }];
      },
    },
    onProgress: (event) => progress.push(event),
  });

  return { service, searched, lyricsFor, submitted, progress };
}

test("an already-collected song costs no search, no lyrics fetch and no submission", async () => {
  const h = harness([{ artist: "BTS", title: "SWIM", isrc: "USA2P2600449" }]);
  const report = await h.service.collect([SWIM, GEUDAE]);

  assert.deepEqual(h.searched, ["송하예 - 그대이길"]);
  assert.deepEqual(h.lyricsFor, ["송하예 - 그대이길"]);
  assert.deepEqual(h.submitted, ["송하예 - 그대이길"]);
  assert.equal(report.skipped, 1);
  assert.equal(report.submitted, 1);

  const skipped = h.progress.find((event) => event.stage === "skipped");
  assert.equal(skipped?.stage === "skipped" && skipped.reason, "collected");
});

test("the chart's spelling does not decide it — normalisation absorbs the difference", async () => {
  const h = harness([{ artist: "bts", title: "swim" }]);
  await h.service.collect([SWIM]);
  assert.deepEqual(h.searched, []);
});

test("nothing is skipped when the catalogue is empty", async () => {
  const h = harness([]);
  const report = await h.service.collect([SWIM, GEUDAE]);
  assert.deepEqual(h.searched, ["BTS - SWIM", "송하예 - 그대이길"]);
  assert.equal(report.skipped, 0);
  assert.equal(report.submitted, 2);
});

test("a song collected earlier in the same run is not collected again", async () => {
  const h = harness([]);
  const report = await h.service.collect([SWIM, { ...SWIM, popularity: 0.5 }]);
  assert.deepEqual(h.submitted, ["BTS - SWIM"]);
  assert.equal(report.skipped, 1);
});

test("an unreachable catalogue collects everything rather than nothing", async () => {
  const h = harness([]);
  const offline = new CollectorService({
    ...h.service.config,
    fetch: (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/admin/api/collector/collected")) throw new Error("network down");
      return Response.json({ job_id: "job-1", deduplicated: false });
    }) as typeof fetch,
  });
  const report = await offline.collect([SWIM]);
  assert.equal(report.skipped, 0);
  assert.equal(report.submitted, 1);
});
