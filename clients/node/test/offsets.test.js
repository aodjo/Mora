import assert from "node:assert/strict";
import test from "node:test";
import { Mora, MoraError, NotAligned } from "../dist/index.js";

/** 서버 대신 미리 짜 둔 응답을 돌려준다. */
function serve(payload, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    clone() {
      return this;
    },
  });
}

test("보조평면 글자가 섞여도 오프셋이 밀리지 않는다", async () => {
  // 서버는 코드포인트로 센다: "사랑"(0,1) "🔥"(2) "해"(3). 자바스크립트에서 🔥 는 두 자리를
  // 차지하므로, 그대로 slice 하면 그 뒤의 모든 낱말이 한 칸씩 밀린다.
  const text = "사랑 🔥 해";
  const original = globalThis.fetch;
  globalThis.fetch = serve({
    tier: "word",
    confidence: 1,
    tokenizer: "unilab-v2",
    alignment_id: 1,
    lines: [[0, 6, 0, 3000]],
    spans: [
      [0, 2, 0, 1000, 0],
      [3, 4, 1000, 2000, 0],
      [5, 6, 2000, 3000, 0],
    ],
  });
  try {
    const result = await new Mora().align(text, { isrc: "TEST00000000" });
    assert.deepEqual(
      result.words.map((word) => word.text),
      ["사랑", "🔥", "해"],
      "코드포인트 오프셋이 UTF-16 자리로 옳게 옮겨져야 한다",
    );
    assert.equal(result.lines[0].text, text);
    // 순진하게 잘랐다면 이렇게 어긋난다 — 이 테스트가 지키는 것이 그 차이다.
    assert.equal(text.slice(3, 4), "픥".slice(0, 0) || text.slice(3, 4));
    assert.notEqual(text.slice(3, 4), "🔥");
  } finally {
    globalThis.fetch = original;
  }
});

test("줄에 속한 낱말만 그 줄에 담긴다", async () => {
  const text = "첫 줄\n둘째 줄";
  const original = globalThis.fetch;
  globalThis.fetch = serve({
    tier: "word",
    confidence: 0.9,
    tokenizer: "unilab-v2",
    alignment_id: 2,
    // "첫 줄\n둘째 줄" — 첫0 ␣1 줄2 \n3 둘4 째5 ␣6 줄7. 줄 span 은 개행을 담지 않는다.
    lines: [
      [0, 3, 0, 1000],
      [4, 8, 2000, 3000],
    ],
    spans: [
      [0, 1, 0, 400, 0],
      [2, 3, 400, 1000, 0],
      [4, 6, 2000, 2500, 1],
      [7, 8, 2500, 3000, 0],
    ],
  });
  try {
    const result = await new Mora().align(text, { artist: "a", title: "b", durationMs: 3000 });
    assert.equal(result.lines.length, 2);
    assert.deepEqual(result.lines[0].words.map((w) => w.text), ["첫", "줄"]);
    assert.deepEqual(result.lines[1].words.map((w) => w.text), ["둘째", "줄"]);
    assert.equal(result.words[2].interpolated, true, "interpolated 1 은 짐작한 자리다");
    assert.equal(result.words[0].interpolated, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("재생 위치로 줄과 낱말을 찾고, 간주에서는 아무것도 주지 않는다", async () => {
  const text = "가 나";
  const original = globalThis.fetch;
  globalThis.fetch = serve({
    tier: "word",
    confidence: 1,
    tokenizer: "unilab-v2",
    alignment_id: 3,
    lines: [[0, 3, 1000, 2000]],
    spans: [
      [0, 1, 1000, 1400, 0],
      [2, 3, 1600, 2000, 0],
    ],
  });
  try {
    const result = await new Mora().align(text, { isrc: "TEST00000000" });
    assert.equal(result.lineAt(1500)?.text, "가 나");
    assert.equal(result.wordAt(1200)?.text, "가");
    assert.equal(result.wordAt(1800)?.text, "나");
    assert.equal(result.wordAt(1500), undefined, "낱말 사이의 틈에는 낱말이 없다");
    assert.equal(result.lineAt(500), undefined, "노래가 시작하기 전");
    assert.equal(result.lineAt(9000), undefined, "노래가 끝난 뒤");
  } finally {
    globalThis.fetch = original;
  }
});

test("맞춰 둔 타이밍이 없으면 NotAligned 로 갈린다", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = serve({ error: "NOT_FOUND" }, 404);
    await assert.rejects(() => new Mora().align("x", { isrc: "NONE" }), (error) => {
      assert.ok(error instanceof NotAligned);
      assert.equal(error.code, "NOT_FOUND");
      return true;
    });

    // tier none 은 곡은 찾았으나 가사가 달라 붙이지 못한 것이다. 부르는 쪽에서는 같은 뜻이다.
    globalThis.fetch = serve({ tier: "none", confidence: 0, lines: [], spans: [] });
    await assert.rejects(() => new Mora().align("x", { isrc: "SOME" }), NotAligned);

    // 서버 고장은 다르게 다뤄야 하므로 NotAligned 가 아니어야 한다.
    globalThis.fetch = serve({ error: "INTERNAL" }, 500);
    await assert.rejects(() => new Mora().align("x", { isrc: "SOME" }), (error) => {
      assert.ok(error instanceof MoraError);
      assert.ok(!(error instanceof NotAligned));
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("LRC 는 낱말 시각까지 적는다", async () => {
  const text = "가 나";
  const original = globalThis.fetch;
  globalThis.fetch = serve({
    tier: "word",
    confidence: 1,
    tokenizer: "unilab-v2",
    alignment_id: 4,
    lines: [[0, 3, 65_430, 67_000]],
    spans: [
      [0, 1, 65_430, 66_000, 0],
      [2, 3, 66_000, 67_000, 0],
    ],
  });
  try {
    const result = await new Mora().align(text, { isrc: "TEST00000000" });
    assert.equal(result.toLrc().trim(), "[01:05.43]<01:05.43>가<01:06.00>나");
    assert.equal(result.toLrc(false).trim(), "[01:05.43]가 나");
  } finally {
    globalThis.fetch = original;
  }
});

test("곡을 가리키지 못하면 부르기 전에 막는다", async () => {
  // 네트워크를 타기 전에 막혀야 한다. 서버까지 갔다 오면 400 을 받아 오지만, 그때는 이미
  // 왕복 한 번을 버린 뒤이고 오류 문구도 부르는 쪽의 실수를 가리키지 않는다.
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("여기까지 오면 안 된다");
  };
  try {
    await assert.rejects(() => new Mora().align("x", { artist: "a", title: "b" }), TypeError);
    await assert.rejects(() => new Mora().align("x", {}), TypeError);
  } finally {
    globalThis.fetch = original;
  }
});
