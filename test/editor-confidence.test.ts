import assert from "node:assert/strict";
import { test } from "node:test";
import { floorMs, syllables, wasGuessed } from "../Admin/src/confidence.js";

test("음절 수는 파이프라인과 같게 센다", () => {
  assert.equal(syllables("날"), 1);
  assert.equal(syllables("도망쳐"), 3);
  assert.equal(syllables("(보다)"), 2);
  assert.equal(syllables("we"), 1);
  assert.equal(syllables("hachiware"), 4);
  assert.equal(syllables("3"), 1);
  assert.equal(syllables("!!"), 1);
});

test("바닥값도 파이프라인과 같다", () => {
  assert.equal(floorMs("날"), 120);
  assert.equal(floorMs("도망쳐"), 300);
  assert.equal(floorMs("홍대"), 200);
});

// 파이프라인이 스스로 말한 것만 믿는다. 자리를 못 찾아 이웃 사이에 끼워 넣은 낱말에는
// 0.3 이하가 붙는다. 길이로 짐작하던 옛 방식은 "the" 처럼 원래 짧은 낱말을 의심했다.
test("파이프라인이 끼워 넣었다고 한 낱말만 표시한다", () => {
  assert.equal(wasGuessed(0.3), true);
  assert.equal(wasGuessed(0.2), true);
  assert.equal(wasGuessed(0.35), true);
});

test("재어진 낱말은 표시하지 않는다", () => {
  assert.equal(wasGuessed(0.47), false, "짧아도 잰 것이면 그대로 둔다 — 실측한 '넌' 은 109ms 에 0.47 이었다");
  assert.equal(wasGuessed(0.62), false);
  assert.equal(wasGuessed(0.9), false);
});

test("점수가 없거나 0이면 표시하지 않는다", () => {
  assert.equal(wasGuessed(undefined), false);
  assert.equal(wasGuessed(0), false, "점수를 담기 전에 만들어진 옛 후보를 의심하지 않는다");
});
