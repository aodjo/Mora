import type { WorkerCapabilities } from "../../packages/contracts/src/index.js";

export interface GeneratorPairingStart {
  pairing_id: string;
  device_code: string;
  pin: string;
  expires_at: number;
  interval_ms: number;
}

export interface GeneratorPairingCredentials {
  worker_id: string;
  api_key: string;
}

interface GeneratorPairingPoll {
  status: "pending" | "approved";
  expires_at?: number;
  worker_id?: string;
  api_key?: string;
}

async function responseJson<T>(response: Response): Promise<T> {
  const value = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `PAIRING_HTTP_${response.status}`);
  return value;
}

export async function startGeneratorPairing(
  adminUrl: string,
  name: string,
  capabilities: WorkerCapabilities,
  fetchImpl: typeof fetch = fetch,
): Promise<GeneratorPairingStart> {
  const response = await fetchImpl(`${adminUrl.replace(/\/$/u, "")}/admin/api/generator/pairings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, capabilities }),
    signal: AbortSignal.timeout(15_000),
  });
  const value = await responseJson<GeneratorPairingStart>(response);
  if (!/^\d{10}$/u.test(value.pin) || typeof value.device_code !== "string" || typeof value.pairing_id !== "string")
    throw new Error("PAIRING_BAD_RESPONSE");
  return value;
}

export async function pollGeneratorPairing(
  adminUrl: string,
  pairing: GeneratorPairingStart,
  fetchImpl: typeof fetch = fetch,
): Promise<GeneratorPairingCredentials | undefined> {
  const response = await fetchImpl(
    `${adminUrl.replace(/\/$/u, "")}/admin/api/generator/pairings/${encodeURIComponent(pairing.pairing_id)}`,
    {
      headers: { authorization: `Pairing ${pairing.device_code}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (response.status === 202) return undefined;
  const value = await responseJson<GeneratorPairingPoll>(response);
  if (value.status !== "approved" || typeof value.worker_id !== "string" || typeof value.api_key !== "string" || value.api_key.length === 0)
    throw new Error("PAIRING_BAD_RESPONSE");
  return { worker_id: value.worker_id, api_key: value.api_key };
}

export async function waitForGeneratorPairing(
  adminUrl: string,
  pairing: GeneratorPairingStart,
  fetchImpl: typeof fetch = fetch,
): Promise<GeneratorPairingCredentials> {
  const interval = Math.max(1000, Math.min(5000, pairing.interval_ms));
  while (Date.now() < pairing.expires_at) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const credentials = await pollGeneratorPairing(adminUrl, pairing, fetchImpl);
    if (credentials !== undefined) return credentials;
  }
  throw new Error("PAIRING_EXPIRED");
}
