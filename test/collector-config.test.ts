import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchCollectorRuntimeConfig, parseCollectorRuntimeConfig } from "../Collector/src/admin-config.js";

const values = {
  MORA_USER_AGENT: "Mora/0.1 (ops@example.com)",
  COLLECTOR_DAILY_BUDGET: "25",
  COLLECTOR_INTERVAL_MS: "3600000",
  COLLECTOR_ONCE: "false",
  COLLECTOR_MARKETS: "KR,JP",
  SONGTITLE_PROVIDERS: "melon,genie",
  SONGTITLE_TIMEOUT_MS: "8000",
  SONGTITLE_BROWSER: "true",
  SONGTITLE_HEADFUL: "false",
  GENIUS_ACCESS_TOKEN: "write-only-secret",
  LYRICFIND_TERRITORY: "KR",
};

test("Collector parses its operational settings from Admin", () => {
  assert.deepEqual(parseCollectorRuntimeConfig({ schema_version: 1, values }), {
    userAgent: "Mora/0.1 (ops@example.com)",
    dailyBudget: 25,
    intervalMs: 3_600_000,
    once: false,
    markets: ["KR", "JP"],
    providers: ["melon", "genie"],
    songTitleTimeoutMs: 8000,
    songTitleBrowser: true,
    songTitleHeadful: false,
    geniusAccessToken: "write-only-secret",
    lyricFindTerritory: "KR",
  });
});

test("Collector config request uses only its service credential", async () => {
  const calls: Array<{ input: string; authorization: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ input: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return Response.json({ schema_version: 1, values });
  };
  const config = await fetchCollectorRuntimeConfig("https://mora.example/", "mora_test", fetchImpl);
  assert.equal(config.dailyBudget, 25);
  assert.deepEqual(calls, [{ input: "https://mora.example/admin/api/collector/config", authorization: "Bearer mora_test" }]);
});

test("a target of zero is a decision, not a broken config", () => {
  // 콘솔에서 C를 눌러 목표를 0으로 두면 Collector가 起動하다 죽었다 — 최소값이 1이었다.
  const config = parseCollectorRuntimeConfig({ schema_version: 1, values: { ...values, COLLECTOR_DAILY_BUDGET: "0" } });
  assert.equal(config.dailyBudget, 0);
});

test("a target outside the range is still refused", () => {
  assert.throws(
    () => parseCollectorRuntimeConfig({ schema_version: 1, values: { ...values, COLLECTOR_DAILY_BUDGET: "-1" } }),
    /COLLECTOR_DAILY_BUDGET/u,
  );
  assert.throws(
    () => parseCollectorRuntimeConfig({ schema_version: 1, values: { ...values, COLLECTOR_DAILY_BUDGET: "9999" } }),
    /COLLECTOR_DAILY_BUDGET/u,
  );
});
