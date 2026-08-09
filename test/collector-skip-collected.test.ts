import assert from "node:assert/strict";
import { test } from "node:test";
import { CollectedIndex, CollectorService } from "../Collector/src/service.js";
import type { CollectorProgress, RecordingSeed, YoutubeCandidate } from "../Collector/src/types.js";

const SWIM: RecordingSeed = { artist: "BTS", title: "SWIM", duration_ms: 159_000, popularity: 1, freshness: 0, market: "KR" };
const GEUDAE: RecordingSeed = { artist: "송하예", title: "그대이길", duration_ms: 188_000, popularity: 0.9, freshness: 0, market: "KR" };

/** 인기순으로 정렬된 가짜 차트. 하루 예산 2곡이면 세 번에 나눠 걷어야 한다. */
const CHART = [
  { artist: "A", title: "1" },
  { artist: "B", title: "2" },
  { artist: "C", title: "3" },
  { artist: "D", title: "4" },
  { artist: "E", title: "5" },
];

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
    if (url.startsWith("https://api.listenbrainz.org/")) {
      return Response.json({
        payload: {
          recordings: CHART.map((row, rank) => ({
            track_name: row.title,
            artist_name: row.artist,
            listen_count: CHART.length - rank,
          })),
        },
      });
    }
    if (url.startsWith("https://musicbrainz.org/")) return Response.json({ recordings: [] });
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
    dailyBudget: 2,
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

  return { service, searched, lyricsFor, submitted, progress, catalogue: collected };
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

test("discover drops what the catalogue holds before it applies the budget", async () => {
  const h = harness([
    { artist: "A", title: "1" },
    { artist: "B", title: "2" },
  ]);
  // 하루 2곡 예산. 이미 가진 A·B를 예산 적용 *전에* 걷어내야 C·D가 나온다.
  const ranked = await h.service.discover(new CollectedIndex(h.catalogue));
  assert.deepEqual(
    ranked.map((seed) => `${seed.artist} - ${seed.title}`),
    ["C - 3", "D - 4"],
  );
});

test("repeated runs walk down the chart instead of standing still", async () => {
  // 예산을 먼저 자르고 나중에 거르면 2회차부터 아무것도 수집하지 못한다.
  const catalogue: Array<{ artist: string; title: string }> = [];
  const order: string[] = [];

  for (let run = 0; run < 4; run++) {
    const h = harness([...catalogue]);
    const report = await h.service.run();
    order.push(...h.submitted);
    for (const name of h.submitted) {
      const [artist, title] = name.split(" - ");
      catalogue.push({ artist: artist!, title: title! });
    }
    // 매 회차는 남은 곡을 예산만큼 새로 가져간다 — 건너뛰기로 예산을 태우지 않는다.
    if (run < 2) assert.equal(report.submitted, 2, `run ${run + 1}`);
  }

  assert.deepEqual(order, ["A - 1", "B - 2", "C - 3", "D - 4", "E - 5"]);
});
