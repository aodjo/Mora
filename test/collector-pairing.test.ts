import assert from "node:assert/strict";
import { test } from "node:test";
import { ServiceError } from "../packages/core/src/shared/errors.js";
import { normalizeCollectorPairingPin } from "../Server/src/admin/collector-pairing.js";
import { pollCollectorPairing, startCollectorPairing } from "../Collector/src/pairing.js";

test("Collector PIN accepts grouped ten-digit input only", () => {
  assert.equal(normalizeCollectorPairingPin("123 456 7890"), "1234567890");
  assert.equal(normalizeCollectorPairingPin("123-456-7890"), "1234567890");
  assert.throws(
    () => normalizeCollectorPairingPin("1234"),
    (error) => error instanceof ServiceError && error.code === "INVALID_REQUEST",
  );
});

test("Collector starts pairing and polls with the private device code", async () => {
  const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization") });
    if (url.endsWith("/pairings")) {
      return Response.json({ pairing_id: "pair-1", device_code: "private-device-code", pin: "1234567890", expires_at: Date.now() + 60_000, interval_ms: 1000 }, { status: 201 });
    }
    return Response.json({ status: "approved", api_key: "mora_collector_key" });
  };
  const pairing = await startCollectorPairing("https://mora.example/", "Mac Collector", fetchImpl);
  assert.equal(pairing.pin, "1234567890");
  assert.equal(await pollCollectorPairing("https://mora.example", pairing, fetchImpl), "mora_collector_key");
  assert.deepEqual(calls, [
    { url: "https://mora.example/admin/api/collector/pairings", method: "POST", authorization: null },
    { url: "https://mora.example/admin/api/collector/pairings/pair-1", method: "GET", authorization: "Pairing private-device-code" },
  ]);
});
