import assert from "node:assert/strict";
import test from "node:test";
import { passesQualityGate } from "../Server/src/admin/quality-gate.js";

const limits = { score: 0.9, density: 0.7, reach: 0.5 };

test("a candidate whose words were actually heard publishes on its own", () => {
  // 한로로 「사랑하게 될 거야」, 실제로 나간 값.
  assert.equal(passesQualityGate({ score: 0.982, language: 1, density: 0.905, reach: 0.95 }, limits), true);
});

test("timings that were guessed do not publish behind a high score", () => {
  // 여섯 지표의 평균은 asr_anchored 를 0/1 로만 본다. 앵커가 하나라도 있으면 1 이므로,
  // 낱말의 절반이 추측인 정렬도 나머지가 만점이면 0.98 을 받는다. 이것이 검수를 거치지
  // 않고 나가던 길이다 — HUNTR/X 「Golden」은 밀도 40%, 코르티스 「REDRED」는 45% 였다.
  assert.equal(passesQualityGate({ score: 0.982, language: 1, density: 0.4, reach: 0.9 }, limits), false);
  assert.equal(passesQualityGate({ score: 0.982, language: 1, density: 0.45, reach: 0.9 }, limits), false);
});

test("a song that is anchored everywhere except one long stretch does not publish", () => {
  // 밀도가 높아도 한 군데가 통째로 비면 사람은 그 한 군데에서 어긋남을 듣는다.
  // reach 는 1 - 최장빈/40 이므로 0.4 는 빈 구간 24 낱말이다.
  assert.equal(passesQualityGate({ score: 0.98, language: 1, density: 0.88, reach: 0.4 }, limits), false);
});

test("candidates from before these were measured go to review", () => {
  // 옛 Generator 의 quality 에는 두 값이 없다. 부르는 쪽이 0 을 넣으므로 여기서 걸린다.
  assert.equal(passesQualityGate({ score: 1, language: 1, density: 0, reach: 0 }, limits), false);
});

test("the language check still stands on its own", () => {
  assert.equal(passesQualityGate({ score: 0.99, language: 0, density: 0.95, reach: 0.95 }, limits), false);
});

test("the floors are boundaries, not gaps", () => {
  assert.equal(passesQualityGate({ score: 0.9, language: 0.9, density: 0.7, reach: 0.5 }, limits), true);
  assert.equal(passesQualityGate({ score: 0.9, language: 0.9, density: 0.699, reach: 0.5 }, limits), false);
  assert.equal(passesQualityGate({ score: 0.9, language: 0.9, density: 0.7, reach: 0.499 }, limits), false);
});
