import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkerCapabilities } from "../packages/contracts/src/index.js";
import { ServiceError } from "../packages/core/src/shared/errors.js";
import { pollGeneratorPairing, startGeneratorPairing } from "../Generator/src/pairing.js";
import { normalizeGeneratorPairingPin } from "../Server/src/admin/generator-pairing.js";

const capabilities: WorkerCapabilities = {
  worker_id: "worker-1",
  version: "0.1.0",
  backend: "mps",
  hardware: "Apple M4",
  capabilities: ["separate", "forced_align"],
  production_ready: true,
  self_test: { mps: "passed", demucs: "passed" },
};

test("Generator PIN accepts grouped ten-digit input only", () => {
  assert.equal(normalizeGeneratorPairingPin("123 456 7890"), "1234567890");
  assert.equal(normalizeGeneratorPairingPin("123-456-7890"), "1234567890");
  assert.throws(
    () => normalizeGeneratorPairingPin("1234"),
    (error) => error instanceof ServiceError && error.code === "INVALID_REQUEST",
  );
});

test("Generator sends capabilities and polls with its private device code", async () => {
  const calls: Array<{ url: string; method: string; authorization: string | null; body?: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
    });
    if (url.endsWith("/pairings")) {
      return Response.json(
        { pairing_id: "pair-1", device_code: "private-device-code", pin: "1234567890", expires_at: Date.now() + 60_000, interval_ms: 1000 },
        { status: 201 },
      );
    }
    return Response.json({ status: "approved", worker_id: "worker-1", api_key: "mora_generator_key" });
  };
  const pairing = await startGeneratorPairing("https://mora.example/", "Mac Generator", capabilities, fetchImpl);
  assert.equal(pairing.pin, "1234567890");
  assert.deepEqual(await pollGeneratorPairing("https://mora.example", pairing, fetchImpl), {
    worker_id: "worker-1",
    api_key: "mora_generator_key",
  });
  assert.deepEqual(calls, [
    {
      url: "https://mora.example/admin/api/generator/pairings",
      method: "POST",
      authorization: null,
      body: { name: "Mac Generator", capabilities },
    },
    { url: "https://mora.example/admin/api/generator/pairings/pair-1", method: "GET", authorization: "Pairing private-device-code" },
  ]);
});
