import assert from "node:assert/strict";
import test from "node:test";
import { validDraft } from "../Server/src/admin/api.js";

// 실측: uruma "하치와레girl" 후보. 괄호 백보컬 [151..154] 가 다음 줄 [155..160] 과 같은
// 초를 쥔다 — 두 목소리가 겹쳐 부르니 그것이 맞다. 예전 검사기는 이걸 거부했고, 화면은
// "초안 저장됨" 이라 말한 뒤 제출이 409 로 돌아왔다.
const OVERLAPPING: Array<[number, number, number]> = [
  [151, 104039, 104622],
  [152, 104622, 104742],
  [153, 104742, 105697],
  [154, 105697, 106190],
  [155, 104019, 104264],
  [156, 104264, 104510],
  [157, 104510, 104755],
  [158, 104755, 105000],
  [159, 105000, 105940],
  [160, 105940, 106743],
];
const LINES: Array<[number, number]> = [
  [104039, 106190],
  [104019, 106743],
];
const EXPECTED = { tokens: OVERLAPPING.map((row) => row[0]), lines: LINES.length };

test("겹쳐 부르는 두 번째 목소리를 받아들인다", () => {
  assert.equal(validDraft({ line_spans: LINES, word_spans: OVERLAPPING }, EXPECTED), true);
});

test("끝이 시작보다 이른 구간은 거부한다", () => {
  const broken = OVERLAPPING.map((row, index) => (index === 3 ? [row[0], 106190, 105697] : row));
  assert.equal(validDraft({ line_spans: LINES, word_spans: broken }, EXPECTED), false);
});

test("길이가 0인 구간도 거부한다", () => {
  const flat = OVERLAPPING.map((row, index) => (index === 3 ? [row[0], 105697, 105697] : row));
  assert.equal(validDraft({ line_spans: LINES, word_spans: flat }, EXPECTED), false);
});

test("낱말이 사라지면 거부한다", () => {
  assert.equal(validDraft({ line_spans: LINES, word_spans: OVERLAPPING.slice(1) }, EXPECTED), false);
});

test("없던 낱말이 생기면 거부한다", () => {
  const invented = OVERLAPPING.map((row, index) => (index === 0 ? [999, row[1], row[2]] : row));
  assert.equal(validDraft({ line_spans: LINES, word_spans: invented }, EXPECTED), false);
});

test("줄 수가 달라지면 거부한다", () => {
  assert.equal(validDraft({ line_spans: LINES.slice(1), word_spans: OVERLAPPING }, EXPECTED), false);
});

test("음수 시작은 거부한다", () => {
  const negative = OVERLAPPING.map((row, index) => (index === 0 ? [row[0], -5, row[2]] : row));
  assert.equal(validDraft({ line_spans: LINES, word_spans: negative }, EXPECTED), false);
});

test("모양이 아닌 것은 거부한다", () => {
  assert.equal(validDraft({ line_spans: LINES, word_spans: "nope" }, EXPECTED), false);
  assert.equal(validDraft({}, EXPECTED), false);
});
