import assert from "node:assert/strict";
import { test } from "node:test";
import { matchFingerprints, type Fingerprint } from "../packages/core/src/index.js";

const source: Fingerprint = {
  lens: [
    [2, 2, 2],
    [2, 4],
    [3, 3, 3],
  ],
  types: [
    [0, 0, 0],
    [0, 0],
    [0, 0, 0],
  ],
};

test("identical fingerprints produce an exact word match", () => {
  const result = matchFingerprints(source, structuredClone(source));
  assert.equal(result.confidence, 1);
  assert.equal(result.tier, "word");
  assert.equal(result.sourceToTargetTokens.size, 8);
  assert.equal(result.sourceToTargetLines.size, 3);
});

test("line additions are absorbed and confidence is dampened", () => {
  const target: Fingerprint = {
    lens: [[1, 1], ...source.lens],
    types: [[1, 1], ...source.types],
  };
  const result = matchFingerprints(source, target);
  assert.equal(result.matchedLines, 3);
  assert.equal(result.sourceToTargetLines.get(0), 1);
  assert.equal(result.tier, "word-approx");
  assert.ok(result.confidence >= 0.6 && result.confidence < 0.9);
});

test("a structurally different song returns none instead of unsafe timing", () => {
  const unrelated: Fingerprint = {
    lens: [[9], [8, 7, 6, 5], [12]],
    types: [[1], [1, 2, 1, 2], [3]],
  };
  const result = matchFingerprints(source, unrelated);
  assert.equal(result.tier, "none");
  assert.ok(result.confidence < 0.6);
});

test("two inserted tokens produce word-approx and remain unmapped for interpolation", () => {
  const longSource: Fingerprint = {
    lens: [[2, 2, 2, 2, 2, 2, 2, 2, 2, 2]],
    types: [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  };
  const target: Fingerprint = {
    lens: [[2, 2, 2, 1, 1, 2, 2, 2, 2, 2, 2, 2]],
    types: [[0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0]],
  };
  const result = matchFingerprints(longSource, target);
  assert.equal(result.tier, "word-approx");
  assert.equal(result.sourceToTargetTokens.size, 10);
  assert.equal(result.sourceToTargetTokens.has(3), true);
  assert.equal([...result.sourceToTargetTokens.values()].includes(3), false);
  assert.equal([...result.sourceToTargetTokens.values()].includes(4), false);
});
