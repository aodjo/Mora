import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AlignmentService, AlignmentStore, fingerprint, serializeOutput, textHash, tokenize } from "../packages/core/src/index.js";

const fixtureText = "나는 오늘 밤에\n너를 기다렸어";
const fixtureTokenization = tokenize(fixtureText);
const fixtureFingerprint = fingerprint(fixtureTokenization);
const fixtureHash = textHash(fixtureTokenization.canonical);
const directory = mkdtempSync(join(tmpdir(), "service-test-"));
const databasePath = join(directory, "service.sqlite");
const store = new AlignmentStore(databasePath);
const service = new AlignmentService(store);

before(() => {
  store.contribute({
    isrc: "KRA382400123",
    mbid: "123e4567-e89b-42d3-a456-426614174000",
    durationMs: 214_000,
    tokenizer: "unilab-v1",
    textHash: fixtureHash,
    fingerprint: fixtureFingerprint,
    lineSpans: [
      [12_000, 13_400],
      [13_600, 14_600],
    ],
    wordSpans: [
      [0, 12_000, 12_350],
      [1, 12_350, 12_800],
      [2, 12_800, 13_400],
      [3, 13_600, 14_000],
      [4, 14_000, 14_600],
    ],
    source: "forced-align",
  });
});

after(() => {
  store.close();
});

test("align returns offsets into caller text and never echoes lyrics", async () => {
  const callerText = "나는 오늘 밤에 (oh)\n너를 기다렸어";
  const result = await service.align({ isrc: "KRA382400123", text: callerText });

  assert.equal(result.tier, "word");
  assert.equal(result.confidence, 1);
  assert.deepEqual(result.spans, [
    [0, 2, 12_000, 12_350, 0],
    [3, 5, 12_350, 12_800, 0],
    [6, 8, 12_800, 13_400, 0],
    [14, 16, 13_600, 14_000, 0],
    [17, 21, 14_000, 14_600, 0],
  ]);
  assert.equal(JSON.stringify(result).includes("나는"), false);
});

test("fingerprint alignment returns target token indices", async () => {
  const result = await service.alignFingerprint({
    mbid: "123e4567-e89b-42d3-a456-426614174000",
    fingerprint: fixtureFingerprint,
  });
  assert.equal(result.tier, "word");
  assert.deepEqual(result.spans[0], [0, 12_000, 12_350, 0]);
});

test("duration validation rejects a mismatched recording version", async () => {
  await assert.rejects(
    service.align({ isrc: "KRA382400123", text: fixtureText, duration_ms: 300_000 }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "NOT_FOUND",
  );
});

test("word-approx interpolates unmatched target tokens inside the line", async () => {
  const approximateStore = new AlignmentStore(":memory:");
  const approximateService = new AlignmentService(approximateStore);
  const sourceFingerprint = {
    lens: [[2, 2, 2, 2, 2, 2, 2, 2, 2, 2]],
    types: [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0]] as const,
  };
  approximateStore.contribute({
    isrc: "KRA382400124",
    tokenizer: "unilab-v1",
    textHash: "0000000000000000",
    fingerprint: { lens: sourceFingerprint.lens, types: sourceFingerprint.types.map((line) => [...line]) },
    lineSpans: [[0, 10_000]],
    wordSpans: Array.from({ length: 10 }, (_, index) => [index, index * 1_000, (index + 1) * 1_000]),
    source: "manual",
  });
  const result = await approximateService.alignFingerprint({
    isrc: "KRA382400124",
    fingerprint: {
      lens: [[2, 2, 2, 1, 1, 2, 2, 2, 2, 2, 2, 2]],
      types: [[0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0]],
    },
  });
  assert.equal(result.tier, "word-approx");
  assert.equal(result.spans.length, 12);
  assert.deepEqual(result.spans.slice(3, 6), [
    [3, 3_000, 3_250, 1],
    [4, 3_250, 3_500, 1],
    [5, 3_500, 4_000, 1],
  ]);
  approximateStore.close();
});

test("numeric WebVTT overlay and local SQLite fixture contain no lyric text", async () => {
  const aligned = await service.align({ isrc: "KRA382400123", text: fixtureText });
  const vttBody = serializeOutput(aligned, "webvtt").body;
  assert.match(vttBody, /^WEBVTT/);
  assert.equal(vttBody.includes("나는"), false);

  store.checkpoint();
  const bytes = readFileSync(databasePath);
  assert.equal(bytes.subarray(0, 15).toString("ascii"), "SQLite format 3");
  assert.equal(bytes.includes(Buffer.from("나는", "utf8")), false);
  assert.equal(bytes.includes(Buffer.from("기다렸어", "utf8")), false);
});
