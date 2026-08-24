import assert from "node:assert/strict";
import test from "node:test";
import { MIN_SPAN_MS, gapFor, placeWord, pushNeighbours } from "../Admin/src/edit.js";
import type { WordSpan } from "../Admin/src/cursor.js";

// 한 줄에 네 낱말, 뒤이어 다른 줄에 하나.
const LINE_OF = (token: number): number => (token >= 4 ? 1 : 0);
const BASE: WordSpan[] = [
  [0, 1000, 1400],
  [1, 1400, 1800],
  [2, 1800, 2200],
  [3, 2200, 2600],
  [4, 2600, 3000],
];

test("왼쪽으로 밀면 앞 낱말의 끝을 먹는다", () => {
  const spans = BASE.map((span) => [...span] as WordSpan);
  spans[2] = [2, 1600, 2200];
  const out = pushNeighbours(spans, 2, LINE_OF);
  assert.deepEqual(out[1], [1, 1400, 1600]);
  assert.deepEqual(out[0], [0, 1000, 1400], "닿지 않은 낱말은 그대로");
});

test("오른쪽으로 밀면 뒤 낱말의 시작을 먹는다", () => {
  const spans = BASE.map((span) => [...span] as WordSpan);
  spans[1] = [1, 1400, 2000];
  const out = pushNeighbours(spans, 1, LINE_OF);
  assert.deepEqual(out[2], [2, 2000, 2200]);
});

test("이웃을 다 먹으면 그 다음 낱말까지 밀린다", () => {
  const spans = BASE.map((span) => [...span] as WordSpan);
  spans[3] = [3, 1500, 2600];
  const out = pushNeighbours(spans, 3, LINE_OF);
  assert.deepEqual(out[2], [2, 1460, 1500], "먹힌 낱말도 최소 길이는 남는다");
  assert.deepEqual(out[1], [1, 1400, 1460]);
  assert.ok(out[1][2] - out[1][1] >= MIN_SPAN_MS);
});

test("줄을 넘어가지 않는다 — 괄호 백보컬의 겹침은 노래가 그런 것이다", () => {
  const spans = BASE.map((span) => [...span] as WordSpan);
  spans[3] = [3, 2200, 2900];
  const out = pushNeighbours(spans, 3, LINE_OF);
  assert.deepEqual(out[4], [4, 2600, 3000], "다른 줄 낱말은 건드리지 않는다");
});

test("겹치지 않으면 아무것도 바뀌지 않는다", () => {
  const out = pushNeighbours(BASE, 2, LINE_OF);
  assert.deepEqual(out, BASE);
});

test("원본을 고치지 않는다", () => {
  const spans = BASE.map((span) => [...span] as WordSpan);
  spans[2] = [2, 1600, 2200];
  const copy = spans.map((span) => [...span]);
  pushNeighbours(spans, 2, LINE_OF);
  assert.deepEqual(spans, copy);
});

test("음수로 밀려나지 않는다", () => {
  const spans: WordSpan[] = [
    [0, 0, 60],
    [1, 60, 400],
  ];
  const out = pushNeighbours([spans[0] as WordSpan, [1, 10, 400]], 1, () => 0);
  assert.ok((out[0] as WordSpan)[1] >= 0, String(out[0]));
  assert.ok((out[0] as WordSpan)[2] >= (out[0] as WordSpan)[1]);
});

// ── 자리 없는 낱말을 제 빈틈에 넣기 ────────────────────────────────────
test("빈틈을 통째로 채운다", () => {
  const spans: WordSpan[] = [
    [0, 100000, 100400],
    [3, 101000, 101400],
  ];
  const { spans: out, row, filled } = placeWord(spans, 1, 0, 120, () => 0);
  assert.equal(row, 1);
  assert.equal(filled, true);
  assert.deepEqual(out[1], [1, 100400, 101000], "앞 낱말이 끝난 곳부터 뒷 낱말이 시작하는 곳까지");
  assert.deepEqual(
    out.map((span) => span[0]),
    [0, 1, 3],
  );
});

test("두 번 누른 자리가 어디든 제 빈틈으로 간다", () => {
  const spans: WordSpan[] = [
    [0, 100000, 100400],
    [3, 101000, 101400],
  ];
  const far = placeWord(spans, 1, 6000, 120, () => 0);
  const near = placeWord(spans, 1, 100700, 120, () => 0);
  assert.deepEqual(far.spans[1], near.spans[1]);
});

test("빈틈이 어느 쪽에만 있어도 넣는다", () => {
  const onlyBefore = placeWord([[0, 100000, 100400]], 1, 0, 120, () => 0);
  assert.equal(onlyBefore.filled, true);
  assert.equal((onlyBefore.spans[1] as WordSpan)[1], 100400);
  const onlyAfter = placeWord([[3, 101000, 101400]], 1, 0, 120, () => 0);
  assert.equal(onlyAfter.filled, true);
  assert.equal((onlyAfter.spans[0] as WordSpan)[2], 101000);
});

test("이웃이 맞닿아 있으면 자리를 만들어 넣고 알린다", () => {
  const spans: WordSpan[] = [
    [0, 100000, 100400],
    [3, 100400, 100800],
  ];
  const { spans: out, row, filled } = placeWord(spans, 1, 0, 120, () => 0);
  assert.equal(filled, false);
  const settled = pushNeighbours(out, row, () => 0);
  assert.ok(
    settled.every((span, i) => i === 0 || span[1] >= (settled[i - 1] as WordSpan)[2]),
    JSON.stringify(settled),
  );
  assert.ok(settled.every((span) => span[2] - span[1] >= MIN_SPAN_MS));
});

test("다른 줄 낱말은 빈틈의 벽이 되지 않는다", () => {
  const spans: WordSpan[] = [
    [0, 100000, 100400],
    [3, 101000, 101400],
  ];
  assert.equal(
    gapFor(spans, 1, (token) => (token === 1 ? 1 : 0)),
    null,
    "제 줄에 이웃이 없으면 빈틈을 알 수 없다",
  );
});

test("빈틈이 없으면 재생 위치를 쓴다", () => {
  const { spans: out, filled } = placeWord([], 0, 4200, 120, () => 0);
  assert.equal(filled, false);
  assert.equal((out[0] as WordSpan)[1], 4200);
});

test("음수 시각으로는 놓이지 않는다", () => {
  const out = placeWord([], 0, -500, 120, () => 0).spans[0] as WordSpan;
  assert.equal(out[1], 0);
});
