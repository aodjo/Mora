import assert from "node:assert/strict";
import test from "node:test";
import { MIN_SPAN_MS, placeWord, pushNeighbours } from "../Admin/src/edit.js";
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

// ── 자리 없는 낱말을 재생 위치에 놓기 ──────────────────────────────────
test("토큰 순서 사이에 끼워 넣는다", () => {
  const spans: WordSpan[] = [
    [0, 1000, 1400],
    [3, 2200, 2600],
  ];
  const { spans: out, row, clamped } = placeWord(spans, 1, 1500, 120, () => 0);
  assert.equal(row, 1);
  assert.equal(clamped, false);
  assert.deepEqual(
    out.map((span) => span[0]),
    [0, 1, 3],
  );
  assert.deepEqual(out[1], [1, 1500, 1740]);
});

test("앞뒤 낱말 밖으로는 놓이지 않는다", () => {
  const spans: WordSpan[] = [
    [0, 100000, 100400],
    [3, 101000, 101400],
  ];
  // 재생 위치가 한참 앞(6초)이어도 그 줄 안에서는 그 자리가 될 수 없다.
  const { spans: out, clamped } = placeWord(spans, 1, 6000, 300, () => 0);
  assert.equal(clamped, true);
  const placed = out[1] as WordSpan;
  assert.ok(placed[1] >= 100400, String(placed));
  assert.ok(placed[2] <= 101000, String(placed));
  assert.ok(
    out.every((span, i) => i === 0 || span[1] >= (out[i - 1] as WordSpan)[2]),
    JSON.stringify(out),
  );
});

test("다른 줄 낱말은 가두는 기준이 되지 않는다", () => {
  const spans: WordSpan[] = [
    [0, 100000, 100400],
    [3, 101000, 101400],
  ];
  const { clamped } = placeWord(spans, 1, 6000, 300, (token) => (token === 1 ? 1 : 0));
  assert.equal(clamped, false, "제 줄에 이웃이 없으면 재생 위치를 그대로 쓴다");
});

test("맨 뒤 토큰은 끝에 붙는다", () => {
  const { spans: out, row } = placeWord([[0, 1000, 1400]], 9, 5000, 300, () => 0);
  assert.equal(row, 1);
  assert.deepEqual(out[1], [9, 5000, 5600]);
});

test("음절이 많으면 더 길게 잡아 준다", () => {
  const one = placeWord([], 0, 0, 120, () => 0).spans[0] as WordSpan;
  const three = placeWord([], 0, 0, 300, () => 0).spans[0] as WordSpan;
  assert.ok(three[2] - three[1] > one[2] - one[1]);
});

test("음수 시각으로는 놓이지 않는다", () => {
  const out = placeWord([], 0, -500, 120, () => 0).spans[0] as WordSpan;
  assert.equal(out[1], 0);
});

test("놓은 뒤 이웃과 겹치면 먹는다", () => {
  const spans: WordSpan[] = [
    [0, 1000, 1400],
    [2, 1500, 1900],
  ];
  const { spans: placed, row } = placeWord(spans, 1, 1300, 300, () => 0);
  const out = pushNeighbours(placed, row, () => 0);
  assert.ok(
    out.every((span, index) => index === 0 || span[1] >= (out[index - 1] as WordSpan)[2]),
    JSON.stringify(out),
  );
  assert.ok(out.every((span) => span[2] - span[1] >= MIN_SPAN_MS));
});
