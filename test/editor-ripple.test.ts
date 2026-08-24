import assert from "node:assert/strict";
import test from "node:test";
import { MIN_SPAN_MS, pushNeighbours } from "../Admin/src/edit.js";
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
