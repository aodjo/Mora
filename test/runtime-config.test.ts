import assert from "node:assert/strict";
import { test } from "node:test";
import { ServiceError } from "../packages/core/src/shared/errors.js";
import { normalizeRuntimeValue, runtimeConfigDefinitions } from "../Server/src/admin/runtime-config.js";

function definition(key: string) {
  const result = runtimeConfigDefinitions.find((item) => item.key === key);
  assert.ok(result);
  return result;
}

test("runtime configuration canonicalizes typed values", () => {
  assert.equal(normalizeRuntimeValue(definition("quality_threshold"), "0.900"), "0.9");
  assert.equal(normalizeRuntimeValue(definition("auto_promotion_enabled"), "true"), "true");
  assert.equal(normalizeRuntimeValue(definition("server.admin_rp_id"), "mora.example.com"), "mora.example.com");
  assert.equal(normalizeRuntimeValue(definition("server.admin_origin"), "https://mora.example.com"), "https://mora.example.com");
  assert.equal(normalizeRuntimeValue(definition("collector.markets"), "kr, US, jp"), "KR,US,JP");
  assert.equal(normalizeRuntimeValue(definition("collector.songtitle_providers"), "Melon, genie"), "melon,genie");
  assert.equal(normalizeRuntimeValue(definition("collector.lyricfind_territory"), "kr"), "KR");
});

test("runtime configuration rejects unsafe values", () => {
  for (const [key, value] of [
    ["quality_threshold", "1.1"],
    ["auto_promotion_enabled", "yes"],
    ["server.dump_url", "http://example.com/dump.sqlite"],
    ["server.dump_url", "https://user:secret@example.com/dump.sqlite"],
    ["server.admin_origin", "https://mora.example.com/admin"],
    ["server.admin_rp_id", "https://mora.example.com"],
    ["collector.daily_budget", "-1"],
    ["collector.daily_budget", "5001"],
    ["collector.markets", "KR,GB"],
    ["collector.songtitle_providers", "melon,unknown"],
    ["collector.lyrics_library_module", "relative/provider.js"],
  ] as const) {
    assert.throws(
      () => normalizeRuntimeValue(definition(key), value),
      (error) => error instanceof ServiceError && error.code === "INVALID_SETTING_VALUE",
    );
  }
});

test("collecting nothing is the default, so starting a Collector does not start collecting", () => {
  // 켰다는 이유만으로 곡이 모이면 안 된다 — 모을지 말지는 사람이 상황판에서 정한다.
  const definition = runtimeConfigDefinitions.find((item) => item.key === "collector.daily_budget");
  assert.ok(definition !== undefined);
  assert.equal(definition.defaultValue, "0");
  assert.equal(definition.min, 0);
  // 0 이 유효해야 콘솔의 C 가 설정을 깨뜨리지 않는다.
  assert.equal(normalizeRuntimeValue(definition, "0"), "0");
});
