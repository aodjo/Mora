import assert from "node:assert/strict";
import test from "node:test";
import { CollectorService } from "../Collector/src/service.js";
import type { RecordingSeed, YoutubeCandidate } from "../Collector/src/types.js";

// Whiplash로 실측한 MB 응답 형태를 그대로 축소한 것.
const RELEASE = {
  media: [
    {
      tracks: [
        { title: "Whiplash", "artist-credit": [{ name: "aespa" }], recording: { id: "rec-1" } },
        { title: "Kill It", "artist-credit": [{ name: "aespa" }], recording: { id: "rec-2" } },
        { title: "Flowers", "artist-credit": [{ name: "aespa" }], recording: { id: "rec-3" } },
      ],
    },
  ],
};

function harness(options: { budget: number; collected?: Array<{ artist: string; title: string }> }) {
  const submitted: string[] = [];
  const service = new CollectorService({
    adminUrl: "https://admin.test",
    adminToken: "t",
    userAgent: "test",
    dailyBudget: options.budget,
    markets: ["KR"],
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/admin/api/collector/collected")) return Response.json({ recordings: options.collected ?? [], skipped: [] });
      // mbid 직접 조회(확장곡)가 검색(차트곡)보다 먼저 걸려야 한다.
      if (/musicbrainz\.org\/ws\/2\/recording\/rec-\d/u.test(url))
        return Response.json({ id: /rec-\d/u.exec(url)![0], title: "곡", isrcs: [], releases: [{ id: "rel-1", title: "Whiplash" }] });
      if (url.includes("musicbrainz.org/ws/2/recording/")) {
        // 차트곡 검색: Whiplash를 rel-1 릴리스로 식별
        return Response.json({
          recordings: [
            {
              id: "rec-1",
              title: "Whiplash",
              score: 100,
              length: 183_000,
              isrcs: ["KRA302400341"],
              "artist-credit": [{ name: "aespa" }],
              releases: [{ id: "rel-1", title: "Whiplash" }],
            },
          ],
        });
      }
      if (url.includes("musicbrainz.org/ws/2/release/rel-1")) return Response.json(RELEASE);
      if (url.endsWith("/admin/api/collector/recordings")) {
        const sent = JSON.parse(String(init?.body)) as { recording: { artist: string; title: string } };
        submitted.push(`${sent.recording.artist} - ${sent.recording.title}`);
        return Response.json({ job_id: `job-${submitted.length}`, deduplicated: false });
      }
      if (url.endsWith("/admin/api/collector/skipped")) return Response.json({ accepted: true });
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch,
    youtubeSearch: async (seed): Promise<YoutubeCandidate[]> => [
      {
        url: "https://music.youtube.com/watch?v=abcdefghijk",
        video_id: "abcdefghijk",
        title: seed.title,
        artist: seed.artist,
        duration_ms: 183_000,
        official: true,
        source_type: "song",
        score: 0.95,
      },
    ],
    lyricsProvider: { search: async () => [{ provider: "test", text: "가사 한 줄", fetched_at: Date.now() }] },
  });
  return { service, submitted };
}

const WHIPLASH: RecordingSeed = { artist: "aespa", title: "Whiplash", popularity: 1, freshness: 0, market: "KR" };

test("a collected hit pulls the rest of its album through the leftover budget", async () => {
  const h = harness({ budget: 5 });
  const report = await h.service.collect([WHIPLASH]);
  // 차트 1곡 + 앨범 나머지 2곡 (Whiplash 자신은 이미 수집됨으로 걸러진다)
  assert.deepEqual(h.submitted, ["aespa - Whiplash", "aespa - Kill It", "aespa - Flowers"]);
  assert.equal(report.submitted, 3);
});

test("expansion never grows past the daily budget", async () => {
  const h = harness({ budget: 2 });
  await h.service.collect([WHIPLASH]);
  // 예산 2: 차트 1곡이 쓰고 남은 1자리만 앨범이 받는다.
  assert.deepEqual(h.submitted, ["aespa - Whiplash", "aespa - Kill It"]);
});

test("album tracks the catalogue already holds are not re-queued", async () => {
  const h = harness({ budget: 5, collected: [{ artist: "aespa", title: "Kill It" }] });
  await h.service.collect([WHIPLASH]);
  assert.deepEqual(h.submitted, ["aespa - Whiplash", "aespa - Flowers"]);
});
