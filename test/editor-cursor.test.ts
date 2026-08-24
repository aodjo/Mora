import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorSpan, isAside } from "../Admin/src/cursor.js";

// 실측: uruma "하치와레girl" 후보에 저장된 낱말 구간. 괄호 줄(151~154)이 다음 줄(155~160)
// 위에 겹쳐 있어, 토큰 순서상 첫 번째를 고르면 커서가 106.19 에서 다음 줄 한가운데로 건너뛴다.
const SPANS: Array<[number, number, number]> = [
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
const ASIDE = new Set([151, 152, 153, 154]);
const second = (token: number): boolean => ASIDE.has(token);

test("겹친 구간에서 커서가 뒤로 가지 않는다", () => {
  let previous = -1;
  for (let at = 104000; at <= 106800; at += 20) {
    const span = cursorSpan(SPANS, at, second);
    if (span === undefined) continue;
    assert.ok(span[1] >= previous, `${at}ms 에서 ${span[0]} 번이 뒤로 갔다`);
    previous = span[1];
  }
});

test("커서는 두 번째 목소리를 잡지 않는다", () => {
  for (let at = 104039; at < 106190; at += 20) {
    const span = cursorSpan(SPANS, at, second);
    if (span !== undefined) assert.ok(!ASIDE.has(span[0]), `${at}ms 에서 괄호 줄 ${span[0]} 번이 커서를 가져갔다`);
  }
});

test("첫 번째를 고르던 옛 방식은 실제로 되돌아갔다 (회귀 대비)", () => {
  const first = (at: number) => SPANS.find((span) => at >= span[1] && at < span[2]);
  const seen: number[] = [];
  for (let at = 104019; at < 106743; at += 20) {
    const span = first(at);
    if (span !== undefined && seen[seen.length - 1] !== span[0]) seen.push(span[0]);
  }
  // 155(다음 줄) 로 시작했다가 151~154(괄호 줄)로 되돌아가고, 다시 160 으로 건너뛴다.
  assert.deepEqual(seen, [155, 151, 152, 153, 154, 160]);
  assert.ok(
    seen.some((token, index) => index > 0 && token < (seen[index - 1] as number)),
    "옛 방식에서 커서가 앞 토큰으로 되돌아간다",
  );
});

test("리드는 순서대로 하나씩 지나간다", () => {
  const seen: number[] = [];
  for (let at = 104019; at < 106743; at += 20) {
    const span = cursorSpan(SPANS, at, second);
    if (span !== undefined && seen[seen.length - 1] !== span[0]) seen.push(span[0]);
  }
  assert.deepEqual(seen, [155, 156, 157, 158, 159, 160]);
});

test("괄호로만 된 줄을 알아본다", () => {
  assert.equal(isAside("(나 너 싫으니까 꺼지라고)"), true);
  assert.equal(isAside("（꺼져）"), true);
  assert.equal(isAside("그래도 제발 나를 사랑해줄래? (꺼져)"), false);
  assert.equal(isAside("(가) 그리고 (나)"), false);
  assert.equal(isAside("어딘지도 모르는"), false);
  assert.equal(isAside("()"), false);
});
