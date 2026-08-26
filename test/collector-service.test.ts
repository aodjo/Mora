import assert from "node:assert/strict";
import test from "node:test";
import {
  CollectedIndex,
  CollectorService,
  canAutoSelect,
  hasNoLyricsToAlign,
  lyricsSearchInput,
  resolveDurationMs,
  reviewReason,
  searchableTitle,
} from "../Collector/src/service.js";
import type { RecordingSeed, YoutubeCandidate } from "../Collector/src/types.js";

const seed: RecordingSeed = { artist: "Artist", title: "Song", popularity: 1, freshness: 0, market: "KR" };
const source: YoutubeCandidate = {
  url: "https://music.youtube.com/watch?v=abcdefghijk",
  video_id: "abcdefghijk",
  title: "Song",
  artist: "Artist",
  duration_ms: 183_400,
  official: true,
  source_type: "topic",
  score: 0.95,
};

test("Collector fills a missing recording duration from the selected media candidate", () => {
  assert.equal(resolveDurationMs(seed, [source]), 183_400);
});

test("Collector keeps an identified MusicBrainz duration", () => {
  assert.equal(resolveDurationMs({ ...seed, duration_ms: 181_234 }, [source]), 181_234);
  assert.equal(resolveDurationMs(seed, []), undefined);
});

test("Collector searches lyrics even before ISRC identification", () => {
  assert.deepEqual(lyricsSearchInput({ ...seed, mbid: "e139bd8d-410c-41c1-967c-a30ee3b444e8" }), {
    mbid: "e139bd8d-410c-41c1-967c-a30ee3b444e8",
    artist: "Artist",
    title: "Song",
  });
});

test("Collector drops tracks that announce they have no vocal", () => {
  // These reached the catalogue and then sat in review forever: nothing can time a track
  // that has no words, and the review screen has no action that resolves one.
  for (const title of [
    "Make up my mind (instrumental)",
    "그대이길 (inst.)",
    "Song (Inst)",
    "Ballad (Off Vocal)",
    "노래 (반주)",
    "Hit (Karaoke Version)",
    "노래 (MR)",
  ]) {
    assert.equal(hasNoLyricsToAlign({ ...seed, title }), true, title);
  }
  // A vocal track keeps its place, including one whose title merely contains the letters.
  for (const title of ["Song", "Instant Crush", "Ministry", "Mr. Blue Sky"]) {
    assert.equal(hasNoLyricsToAlign({ ...seed, title }), false, title);
  }
});

test("Review reasons name what is actually missing", () => {
  const candidate = { ...source, score: 0.86, official: false };
  // The two songs that kept reaching review with an ISRC and candidates: the shortlist simply
  // never cleared auto-selection, which the log could not say before.
  assert.equal(reviewReason(["source"], [candidate]), "자동 선택 기준 미달 (카탈로그 길이 없음, 아티스트 채널 아님)");
  assert.equal(reviewReason(["source"], [{ ...candidate, catalogue_drift_ms: 86_000 }]), "자동 선택 기준 미달 (길이 86.0초 차이)");
  assert.equal(reviewReason(["source"], [{ ...candidate, score: 0.7 }]), "자동 선택 기준 미달 (점수 0.70)");
  assert.equal(reviewReason(["source"], []), "음원 후보 없음");
});

test("the catalogue length decides auto-selection, not who uploaded the file", () => {
  // Measured against Spotify for the real uploads: 993ms, 467ms and 920ms out.
  const reupload: YoutubeCandidate = { ...source, official: false, score: 0.86, catalogue_drift_ms: 993 };
  assert.equal(canAutoSelect(reupload), true);

  // BTS' own channels hold a 4:05 music video for a 2:39 recording.
  assert.equal(canAutoSelect({ ...reupload, official: true, catalogue_drift_ms: 86_000 }), false);

  // Nothing authoritative answered, so ownership is all that is left to go on.
  assert.equal(canAutoSelect({ ...source, official: true, score: 0.86, catalogue_drift_ms: undefined }), true);
  assert.equal(canAutoSelect({ ...source, official: false, score: 0.86, catalogue_drift_ms: undefined }), false);

  // A weak title or artist match is disqualifying however well the length agrees.
  assert.equal(canAutoSelect({ ...reupload, score: 0.7 }), false);
  assert.equal(canAutoSelect(undefined), false);
});

test("the length on the recording decides even when LyricFind never answered", () => {
  // MusicBrainz hands back the ISRC and the length together, so enrichment stops there and no
  // catalogue length is ever recorded. That is the common case, not the exception, and it used
  // to leave ownership as the only way through — which is why almost everything sat in review.
  const swim: YoutubeCandidate = { ...source, official: false, score: 0.88, duration_ms: 159_400, catalogue_drift_ms: undefined };
  assert.equal(canAutoSelect(swim, 159_000), true);

  // The 4:05 music video on the artist's own channel against a 2:39 recording. Ownership is a
  // nudge in the score, never a substitute for a length that disagrees.
  assert.equal(canAutoSelect({ ...swim, official: true, score: 0.93, duration_ms: 245_000 }, 159_000), false);
  // 3s is the tolerance: measured across 70 clean alignments the gap peaked at 2.4s.
  assert.equal(canAutoSelect({ ...swim, duration_ms: 156_000 }, 159_000), true);
  assert.equal(canAutoSelect({ ...swim, duration_ms: 155_000 }, 159_000), false);

  // The catalogue's answer is preferred when there is one, and it is the stricter judge here.
  assert.equal(canAutoSelect({ ...swim, catalogue_drift_ms: 86_000 }, 159_000), false);

  // No length anywhere and no length on the upload: nothing to compare, so ownership is all
  // that is left. It is the fallback, not the rule.
  assert.equal(canAutoSelect({ ...swim, duration_ms: 0 }, undefined), false);
  assert.equal(canAutoSelect({ ...swim, duration_ms: 0, official: true }, undefined), true);

  // A length match cannot rescue an upload that does not say it is this song.
  assert.equal(canAutoSelect({ ...swim, score: 0.68 }, 159_000), false);
});

test("a song already in the catalogue is skipped before anything is spent", () => {
  const index = new CollectedIndex([
    { artist: "BTS", title: "SWIM", isrc: "USA2P2600449" },
    { artist: "송하예", title: "그대이길" },
  ]);
  assert.equal(index.hasName({ ...seed, artist: "BTS", title: "SWIM" }), true);
  // 차트마다 표기가 흔들려도 정규화가 흡수한다.
  assert.equal(index.hasName({ ...seed, artist: "bts", title: "swim" }), true);
  assert.equal(index.hasName({ ...seed, artist: "BTS", title: "Come Over" }), false);

  // 이름이 달라도 식별이 끝나면 ISRC가 같은 녹음임을 알려준다.
  assert.equal(index.hasIsrc({ ...seed, artist: "방탄소년단", title: "SWIM", isrc: "usa2p2600449" }), true);
  assert.equal(index.hasIsrc({ ...seed, isrc: "KRA302600331" }), false);
  assert.equal(index.hasIsrc(seed), false);

  // ISRC가 없는 곡도 이름으로는 걸린다.
  assert.equal(index.hasName({ ...seed, artist: "송하예", title: "그대이길" }), true);
});

test("a song collected during the run is not collected twice", () => {
  const index = new CollectedIndex([]);
  const swim = { ...seed, artist: "BTS", title: "SWIM", isrc: "USA2P2600449" };
  assert.equal(index.hasName(swim), false);
  index.remember(swim);
  assert.equal(index.hasName(swim), true);
  assert.equal(index.hasIsrc({ ...seed, artist: "방탄소년단", title: "Swim", isrc: "USA2P2600449" }), true);
});

test("LyricFind supplies the ISRC and catalogue length", async () => {
  const submitted: Array<Record<string, unknown>> = [];
  const searchSeeds: RecordingSeed[] = [];
  const service = new CollectorService({
    adminUrl: "https://admin.test",
    adminToken: "t",
    userAgent: "test",
    dailyBudget: 5,
    markets: ["KR"],
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/collector/collected")) return Response.json({ recordings: [], skipped: [] });
      if (url.includes("/collector/recordings")) {
        submitted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ job_id: "job-1", deduplicated: false });
      }
      return Response.json({ accepted: true });
    }) as typeof fetch,
    youtubeSearch: async (seed) => {
      // 보강이 검색까지 도달했는지가 핵심이다 — 드리프트 계산은 실제 검색 모듈을 흉내 낸다.
      searchSeeds.push(seed);
      return [
        {
          url: "https://music.youtube.com/watch?v=abcdefghijk",
          video_id: "abcdefghijk",
          title: seed.title,
          artist: seed.artist,
          duration_ms: 159_007,
          official: false,
          source_type: "unofficial",
          score: 0.95,
          ...(seed.catalogue_duration_ms === undefined ? {} : { catalogue_drift_ms: Math.abs(seed.catalogue_duration_ms - 159_007) }),
        },
      ];
    },
    lyricsProvider: { search: async () => [{ provider: "test", text: "가사 한 줄", fetched_at: Date.now() }] },
    lyricfind: { identify: async () => ({ isrc: "USA2P2600449", durationMs: 159_000 }) },
  });
  const report = await service.collect([{ artist: "BTS", title: "SWIM", popularity: 1, freshness: 0, market: "KR" }]);
  assert.equal(report.submitted, 1);
  assert.equal(searchSeeds[0]?.isrc, "USA2P2600449");
  assert.equal(searchSeeds[0]?.catalogue_duration_ms, 159_000);
  const recording = submitted[0]?.recording as { isrc?: string };
  assert.equal(recording.isrc, "USA2P2600449");
  // 길이가 생겼으니 드리프트 게이트가 비공식 업로드도 자동 선택할 수 있다.
  const sources = submitted[0]?.sources as Array<{ selected?: boolean; catalogue_drift_ms?: number }>;
  assert.equal(sources[0]?.selected, true);
  assert.equal(sources[0]?.catalogue_drift_ms, 7);
});

test("a missing ISRC is no longer a reason to stop", async () => {
  // ISRC가 없다고 검수로 보내면, 타이밍을 만들 수 있는 곡이 코드 하나 때문에 멈춰 선다.
  // 공개할 때는 여전히 필요하지만 그것은 나중 일이다.
  assert.equal(reviewReason([], []), "확인 필요");
  const candidate: YoutubeCandidate = {
    url: "https://music.youtube.com/watch?v=abcdefghijk",
    video_id: "abcdefghijk",
    title: "SWIM",
    artist: "BTS",
    duration_ms: 159_000,
    official: true,
    source_type: "song",
    score: 0.95,
  };
  // 음원이 없을 때만 멈추는 이유가 된다.
  assert.equal(reviewReason(["source"], [candidate]), "자동 선택 기준 미달 (카탈로그 길이 없음, 아티스트 채널 아님)");
});

test("a song with no ISRC still goes to the Generator", async () => {
  const submitted: Array<Record<string, unknown>> = [];
  const service = new CollectorService({
    adminUrl: "https://admin.test",
    adminToken: "t",
    userAgent: "test",
    dailyBudget: 5,
    markets: ["KR"],
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/collector/collected")) return Response.json({ recordings: [], skipped: [] });
      if (url.includes("/collector/recordings")) {
        submitted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        // 서버는 음원만 확정되면 작업을 연다.
        return Response.json({ job_id: "job-1", deduplicated: false });
      }
      return Response.json({ accepted: true });
    }) as typeof fetch,
    youtubeSearch: async (seed) => [
      {
        url: "https://music.youtube.com/watch?v=abcdefghijk",
        video_id: "abcdefghijk",
        title: seed.title,
        artist: seed.artist,
        duration_ms: 159_000,
        official: true,
        source_type: "song",
        score: 0.95,
      },
    ],
    lyricsProvider: { search: async () => [{ provider: "test", text: "가사 한 줄", fetched_at: Date.now() }] },
  });
  const report = await service.collect([{ artist: "Storyinsoil", title: "Flux", popularity: 1, freshness: 0, market: "KR" }]);
  assert.equal(report.submitted, 1);
  assert.equal(report.review, 0);
  assert.equal((submitted[0]?.recording as { isrc?: string }).isrc, undefined);
});

test("a credit clause does not hide a song from its own lyrics", () => {
  // 실측: 이 제목 그대로는 5개 서비스 전부 0건, feat 절을 빼면 genie·flo 가 바로 내놓았다.
  assert.equal(searchableTitle("살인 아니고 사랑인데요?? (Feat. $ATSUKI & 백노루양 of 나의 노랑말들)"), "살인 아니고 사랑인데요??");
  assert.equal(searchableTitle("하치와레girl feat.pshine"), "하치와레girl");
  assert.equal(searchableTitle("떠나 (Prod. PATEKO (파테코))"), "떠나");
  // 크레딧이 없는 제목은 손대지 않는다.
  assert.equal(searchableTitle("좋은 날"), "좋은 날");
  assert.equal(searchableTitle("With You"), "With You");
  // 제목 자체가 With 로 시작해도 지워서 빈 문자열을 만들지는 않는다.
  assert.equal(searchableTitle("(with UV)"), "(with UV)");
});
