import assert from "node:assert/strict";
import test from "node:test";
import { sheetHash, textHash } from "../packages/core/src/tokenization/fingerprint.js";

// 실측: Ruru "살인 아니고 사랑인데요??" 를 genie 는 48줄로, flo 는 61줄로 끊었다.
// 낱말은 한 자도 다르지 않은데 두 벌의 후보가 만들어져 같은 점수로 나란히 떴다.
const GENIE = "있잖아 사실 난 말이야\n너를 내가 혼자 가지고 싶어\n있잖아 내가 널 말이야";
const FLO = "있잖아 사실 난 말이야\n너를 내가\n혼자 가지고 싶어\n있잖아 내가 널 말이야";

test("줄을 다르게 끊은 같은 가사는 한 가사다", () => {
  assert.equal(sheetHash(GENIE), sheetHash(FLO));
});

test("줄바꿈까지 세던 옛 방식은 갈라놓았다 (회귀 대비)", () => {
  assert.notEqual(textHash(GENIE), textHash(FLO));
});

test("낱말이 다르면 다른 가사다", () => {
  assert.notEqual(sheetHash(GENIE), sheetHash(GENIE.replace("혼자", "둘이")));
});

test("낱말 순서가 다르면 다른 가사다", () => {
  assert.notEqual(sheetHash("가 나 다"), sheetHash("다 나 가"));
});

test("앞뒤 여백과 겹친 공백은 같은 것으로 본다", () => {
  assert.equal(sheetHash("  가  나 \n\n 다  "), sheetHash("가 나 다"));
});

test("빈 가사끼리는 같다", () => {
  assert.equal(sheetHash(""), sheetHash("\n\n"));
});
