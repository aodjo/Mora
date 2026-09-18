import assert from "node:assert/strict";
import test from "node:test";
import { ANCHOR_DENSITY_FLOOR, ANCHOR_REACH_FLOOR, BREATH_FLOOR, passesQualityGate } from "../Server/src/admin/quality-gate.js";

const LIMITS = { score: 0.92, density: ANCHOR_DENSITY_FLOOR, reach: ANCHOR_REACH_FLOOR, breath: BREATH_FLOOR };

/** 검정치마 EVERYTHING 이 실제로 낸 값. 물러선 것 말고는 아무것도 이것을 막지 못한다. */
const EVERYTHING = { id: "x", score: 0.96, language: 1, density: 0.847, reach: 0.925, breath: 1 };

test("a candidate the sung aligner fell back from is not published on its own", () => {
  // 지표는 전부 문을 넘는다 — 사람이 듣고서야 최악인 줄 알았다. 물러섰다는 사실만이 그것을
  // 미리 말할 수 있다.
  assert.equal(passesQualityGate({ ...EVERYTHING, aligner: "sung" }, LIMITS), true);
  assert.equal(passesQualityGate({ ...EVERYTHING, aligner: "fallback" }, LIMITS), false);
});

test("a song that was never meant for the sung aligner still publishes", () => {
  // 한국어가 아닌 곡은 whisperx 로 가는 것이 정상이다. 물러선 것과 뭉치면 영어 곡이 전부
  // 검수함에 쌓인다.
  assert.equal(passesQualityGate({ ...EVERYTHING, aligner: "whisperx" }, LIMITS), true);
});

test("a candidate from before this was recorded is not held back", () => {
  // 옛 Generator 는 이 말을 안 한다. 모르는 것을 전부 막으면 밀린 후보가 통째로 사람에게 간다.
  assert.equal(passesQualityGate({ ...EVERYTHING, aligner: "unknown" }, LIMITS), true);
  assert.equal(passesQualityGate(EVERYTHING, LIMITS), true);
});

test("falling back does not rescue a candidate that fails the floors anyway", () => {
  const thin = { id: "y", score: 0.99, language: 1, density: 0.3, reach: 0.9, breath: 1 };
  assert.equal(passesQualityGate({ ...thin, aligner: "sung" }, LIMITS), false);
  assert.equal(passesQualityGate({ ...thin, aligner: "fallback" }, LIMITS), false);
});
