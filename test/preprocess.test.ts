import assert from "node:assert/strict";
import { test } from "node:test";
import { preprocessLyrics } from "../packages/preprocess/src/index.js";
import { tokenizeV2 } from "../packages/core/src/index.js";

test("preprocessing preserves sung parentheticals and removes section metadata", () => {
  const result = preprocessLyrics("[Verse 1]\r\nHello (oh oh)\nLyrics by: Example\n번역: 안녕", "en");
  assert.equal(result.variants[0]?.text, "Hello (oh oh)");
  assert.equal(result.variants[1]?.layer, "translation");
  assert.equal(result.variants[1]?.text, "안녕");
});

test("repeat markers create a reviewable expanded variant", () => {
  const result = preprocessLyrics("[Chorus]\n다시 만나\n\n(x2)", "ko");
  assert.equal(result.variants[0]?.text, "다시 만나\n다시 만나");
  assert.equal(result.variants[0]?.review_required, true);
});

test("unilab-v2 segments Japanese and keeps codepoint offsets", () => {
  const result = tokenizeV2("君の名前を呼ぶ", "ja");
  assert.ok(result.tokens.length > 1);
  for (const token of result.tokens) assert.ok(token.end > token.start);
});
