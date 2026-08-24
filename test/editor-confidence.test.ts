import assert from "node:assert/strict";
import { test } from "node:test";
import { floorMs, onlyTheFloor, syllables } from "../Admin/src/confidence.js";

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

// 실측: uruma "하치와레girl" 후보에서 바닥에 붙어 있던 낱말들. 점수는 0.47~0.61 로
// 잰 것처럼 보이지만 길이는 바닥이다 — 점수로는 못 찾고 바닥으로는 찾는다.
test("짓눌린 한 글자 낱말을 찾아낸다", () => {
  assert.equal(onlyTheFloor("날", 0, 106), true);
  assert.equal(onlyTheFloor("넌", 0, 109), true);
  assert.equal(onlyTheFloor("비", 0, 120), true);
  assert.equal(onlyTheFloor("홍대", 0, 201), true);
});

test("제대로 잰 낱말은 표시하지 않는다", () => {
  assert.equal(onlyTheFloor("사랑해줄래", 0, 792), false);
  assert.equal(onlyTheFloor("날", 0, 240), false);
  assert.equal(onlyTheFloor("도망쳐", 0, 560), false);
});
