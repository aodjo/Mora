import assert from "node:assert/strict";
import test from "node:test";
import { MusicBrainzClient } from "../Collector/src/musicbrainz.js";
import type { RecordingSeed } from "../Collector/src/types.js";

const seed: RecordingSeed = {
  artist: "BTS",
  title: "Butter",
  duration_ms: 165_000,
  mbid: "e139bd8d-410c-41c1-967c-a30ee3b444e8",
  popularity: 1,
  freshness: 0,
  market: "KR",
};

test("MusicBrainz resolves a known MBID directly and enriches its ISRC", async () => {
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    requests.push(String(input));
    return new Response(
      JSON.stringify({ id: seed.mbid, title: "Butter", length: 164_441, isrcs: ["QM6-MZ2-15-6864"], releases: [{ title: "Butter" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const identified = await new MusicBrainzClient("Mora test", fetcher).identify(seed);
  assert.equal(requests.length, 1);
  assert.match(requests[0] ?? "", /\/recording\/e139bd8d-410c-41c1-967c-a30ee3b444e8\?/u);
  assert.equal(identified.isrc, "QM6MZ2156864");
  assert.equal(identified.duration_ms, 164_441);
});
