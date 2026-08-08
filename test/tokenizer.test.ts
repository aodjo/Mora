import assert from "node:assert/strict";
import { test } from "node:test";
import { fingerprint, textHash, tokenize } from "../packages/core/src/index.js";

test("unilab-v1 preserves original codepoint offsets", () => {
  const input = "😀 Cafe\u0301!\n안녕, 세상";
  const result = tokenize(input);

  assert.deepEqual(
    result.tokens.map(({ start, end, canonical, line }) => ({ start, end, canonical, line })),
    [
      { start: 0, end: 1, canonical: "😀", line: 0 },
      { start: 2, end: 7, canonical: "café", line: 0 },
      { start: 9, end: 11, canonical: "안녕", line: 1 },
      { start: 13, end: 15, canonical: "세상", line: 1 },
    ],
  );
  for (const token of result.tokens) {
    assert.equal(
      Array.from(input).slice(token.start, token.end).join("").replace(/[!,]/gu, ""),
      token.line === 0 && token.start === 2 ? "Café" : token.canonical,
    );
  }
});

test("case, quote, punctuation, and bracketed backing vocals normalize away", () => {
  const plain = tokenize("Hello world\n나는 오늘 밤에");
  const variant = tokenize("“HELLO,” WORLD!\n나는 오늘 밤에 (oh oh)");

  assert.equal(plain.canonical, "hello world\n나는 오늘 밤에");
  assert.equal(variant.canonical, plain.canonical);
  assert.equal(textHash(variant.canonical), textHash(plain.canonical));
  assert.deepEqual(fingerprint(variant), fingerprint(plain));
});

test("standalone section headers and empty lines do not enter the fingerprint", () => {
  const result = tokenize("[Verse 1]\n\n첫 번째 줄\r\n(Chorus)\r둘째 줄");
  assert.equal(result.canonical, "첫 번째 줄\n둘째 줄");
  assert.deepEqual(fingerprint(result).lens, [
    [1, 2, 1],
    [2, 1],
  ]);
  assert.deepEqual(
    result.tokens.map((token) => token.line),
    [2, 2, 2, 4, 4],
  );
});

test("token types are stable numeric categories", () => {
  const result = fingerprint(tokenize("한글 Latin 123 K-pop 😀"));
  assert.deepEqual(result.types, [[0, 1, 2, 3, 3]]);
});
