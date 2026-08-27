import assert from "node:assert/strict";
import test from "node:test";
import { passesQualityGate } from "../Server/src/admin/quality-gate.js";

const limits = { score: 0.9, density: 0.7, reach: 0.5, breath: 0.65 };

test("a candidate whose words were actually heard publishes on its own", () => {
  // 한로로 「사랑하게 될 거야」, 실제로 나간 값.
  assert.equal(passesQualityGate({ score: 0.982, language: 1, density: 0.905, reach: 0.95, breath: 0.92 }, limits), true);
});

test("timings that were guessed do not publish behind a high score", () => {
  // 여섯 지표의 평균은 asr_anchored 를 0/1 로만 본다. 앵커가 하나라도 있으면 1 이므로,
  // 낱말의 절반이 추측인 정렬도 나머지가 만점이면 0.98 을 받는다. 이것이 검수를 거치지
  // 않고 나가던 길이다 — HUNTR/X 「Golden」은 밀도 40%, 코르티스 「REDRED」는 45% 였다.
  assert.equal(passesQualityGate({ score: 0.982, language: 1, density: 0.4, reach: 0.9, breath: 1 }, limits), false);
  assert.equal(passesQualityGate({ score: 0.982, language: 1, density: 0.45, reach: 0.9, breath: 1 }, limits), false);
});

test("a song that is anchored everywhere except one long stretch does not publish", () => {
  // 밀도가 높아도 한 군데가 통째로 비면 사람은 그 한 군데에서 어긋남을 듣는다.
  // reach 는 1 - 최장빈/40 이므로 0.4 는 빈 구간 24 낱말이다.
  assert.equal(passesQualityGate({ score: 0.98, language: 1, density: 0.88, reach: 0.4, breath: 1 }, limits), false);
});

test("words that sit where nobody breathes do not publish, however dense the anchors", () => {
  // 「저 병원가기전에 유부초밥이 먹고싶은데요」, 실제로 잰 값. 밀도 0.98 로 앵커 문턱을
  // 넉넉히 넘지만 줄 사이 열 곳 중 넷만 숨 쉬는 자리다 — 나머지는 노래 한가운데에서 줄이
  // 끊긴다. 앵커가 보지 못하는 것이 정확히 이것이고, 이 잣대를 더한 이유가 이 한 곡이다.
  assert.equal(passesQualityGate({ score: 0.97, language: 1, density: 0.98, reach: 0.95, breath: 0.4 }, limits), false);
  // 다시 돌리면 0.50 이 나오기도 한다. 문턱이 그 위에 있으면 돌린 날에 따라 결과가 달라진다.
  assert.equal(passesQualityGate({ score: 0.97, language: 1, density: 0.98, reach: 0.95, breath: 0.5 }, limits), false);
  // 나머지 열한 곡은 81~100% 에 모여 있었다.
  assert.equal(passesQualityGate({ score: 0.97, language: 1, density: 0.98, reach: 0.95, breath: 0.81 }, limits), true);
});

test("a song with too few gaps to judge is not punished for it", () => {
  // 잴 틈이 모자라면 Generator 가 1 을 실어 보낸다. "재어 봤는데 할 말이 없다"는 뜻이지
  // "엉망이다"가 아니다 — 여기서 막으면 짧은 곡이 전부 사람에게 간다.
  assert.equal(passesQualityGate({ score: 0.95, language: 1, density: 0.9, reach: 0.9, breath: 1 }, limits), true);
});

test("candidates from before these were measured go to review", () => {
  // 옛 Generator 의 quality 에는 세 값이 없다. 부르는 쪽이 0 을 넣으므로 여기서 걸린다.
  assert.equal(passesQualityGate({ score: 1, language: 1, density: 0, reach: 0, breath: 0 }, limits), false);
  // 앵커 둘만 있고 숨 자리가 없는 후보도 마찬가지다.
  assert.equal(passesQualityGate({ score: 1, language: 1, density: 0.95, reach: 0.95, breath: 0 }, limits), false);
});

test("the language check still stands on its own", () => {
  assert.equal(passesQualityGate({ score: 0.99, language: 0, density: 0.95, reach: 0.95, breath: 1 }, limits), false);
});

test("the floors are boundaries, not gaps", () => {
  assert.equal(passesQualityGate({ score: 0.9, language: 0.9, density: 0.7, reach: 0.5, breath: 0.65 }, limits), true);
  assert.equal(passesQualityGate({ score: 0.9, language: 0.9, density: 0.699, reach: 0.5, breath: 0.65 }, limits), false);
  assert.equal(passesQualityGate({ score: 0.9, language: 0.9, density: 0.7, reach: 0.499, breath: 0.65 }, limits), false);
  assert.equal(passesQualityGate({ score: 0.9, language: 0.9, density: 0.7, reach: 0.5, breath: 0.649 }, limits), false);
});
