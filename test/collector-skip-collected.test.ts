import assert from "node:assert/strict";
import { test } from "node:test";
import { CollectedIndex, CollectorService } from "../Collector/src/service.js";
import type { LyricsProviderResult } from "../packages/contracts/src/index.js";
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
interface Harness {
  service: CollectorService;
  searched: string[];
  lyricsFor: string[];
  submitted: string[];
  skips: Array<{ artist: string; title: string; reason: string }>;
  progress: CollectorProgress[];
  catalogue: Array<{ artist: string; title: string; isrc?: string }>;
  /** 이 실행에서 가사 제공자가 내놓을 결과. 빈 배열이면 "가사 없음" 경로를 탄다. */
  lyrics: LyricsProviderResult[];
  /** true면 YouTube 검색이 빈손으로 돌아온다. */
  noSources: boolean;
}

function harness(
  collected: Array<{ artist: string; title: string; isrc?: string }>,
  skipped: Array<{ artist: string; title: string }> = [],
): Harness {
  const lyricsBox: { value: LyricsProviderResult[] } = {
    value: [{ provider: "test", text: "가사 한 줄", fetched_at: Date.now() }],
  };
  const sourceBox = { none: false };
  const searched: string[] = [];
  const lyricsFor: string[] = [];
  const submitted: string[] = [];
  const skips: Array<{ artist: string; title: string; reason: string }> = [];
  const progress: CollectorProgress[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/admin/api/collector/collected")) return Response.json({ recordings: collected, skipped });
    if (url.endsWith("/admin/api/collector/skipped")) {
      skips.push(JSON.parse(String(init?.body)) as { artist: string; title: string; reason: string });
      return Response.json({ accepted: true });
    }
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
      if (sourceBox.none) return [];
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
        return lyricsBox.value;
      },
    },
    onProgress: (event) => progress.push(event),
  });

  return {
    service,
    searched,
    lyricsFor,
    submitted,
    skips,
    progress,
    catalogue: collected,
    get lyrics() {
      return lyricsBox.value;
    },
    set lyrics(value: LyricsProviderResult[]) {
      lyricsBox.value = value;
    },
    get noSources() {
      return sourceBox.none;
    },
    set noSources(value: boolean) {
      sourceBox.none = value;
    },
  };
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

test("a song skipped for having no lyrics is not paid for again next run", async () => {
  // 건너뛴 곡은 recordings 에 남지 않으므로, 서버가 따로 기억해 주지 않으면
  // 매 실행마다 가사 제공자 다섯 곳을 다시 묻게 된다.
  const first = harness([]);
  first.lyrics = [];
  const report = await first.service.collect([SWIM]);
  assert.equal(report.skipped, 1);
  assert.deepEqual(first.skips, [{ artist: "BTS", title: "SWIM", reason: "no-lyrics" }]);

  // 서버가 그 스킵을 돌려주면 다음 실행은 검색도 가사 조회도 하지 않는다.
  const next = harness([], [{ artist: "BTS", title: "SWIM" }]);
  const again = await next.service.collect([SWIM]);
  assert.deepEqual(next.searched, []);
  assert.deepEqual(next.lyricsFor, []);
  assert.equal(again.skipped, 1);
});

test("an instrumental is recorded as one and never costs a lyrics lookup", async () => {
  const h = harness([]);
  const report = await h.service.collect([{ ...SWIM, title: "SWIM (instrumental)" }]);
  assert.equal(report.skipped, 1);
  assert.deepEqual(h.lyricsFor, []);
  assert.deepEqual(h.skips, [{ artist: "BTS", title: "SWIM (instrumental)", reason: "instrumental" }]);
});

test("a song with no playable source is a remembered skip, not a failure", async () => {
  // 실측: Megasound 4곡 — 카탈로그 길이도, 재생할 업로드도 없어 매 실행
  // "수집 실패 (DURATION_UNAVAILABLE)"로 반복됐다. 시드에 길이가 없는 게 조건이다.
  const OBSCURE: RecordingSeed = { artist: "Megasound", title: "Keep On Running", popularity: 0.1, freshness: 0.9, market: "US" };
  const h = harness([]);
  h.noSources = true;
  const report = await h.service.collect([OBSCURE]);
  assert.deepEqual(report.errors, []);
  assert.equal(report.skipped, 1);
  assert.deepEqual(h.skips, [{ artist: "Megasound", title: "Keep On Running", reason: "no-source" }]);

  // 기억됐으니 다음 실행은 검색조차 하지 않는다.
  const next = harness([], [{ artist: "Megasound", title: "Keep On Running" }]);
  await next.service.collect([OBSCURE]);
  assert.deepEqual(next.searched, []);
});
