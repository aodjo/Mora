export interface CollectorPairingStart {
  pairing_id: string;
  device_code: string;
  pin: string;
  expires_at: number;
  interval_ms: number;
}

interface CollectorPairingPoll {
  status: "pending" | "approved";
  expires_at?: number;
  api_key?: string;
}

async function responseJson<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `PAIRING_HTTP_${response.status}`);
  return value;
}

export async function startCollectorPairing(adminUrl: string, name: string, fetchImpl: typeof fetch = fetch): Promise<CollectorPairingStart> {
  const response = await fetchImpl(`${adminUrl.replace(/\/$/u, "")}/admin/api/collector/pairings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(15_000),
  });
  const value = await responseJson<CollectorPairingStart>(response);
  if (!/^\d{10}$/u.test(value.pin) || typeof value.device_code !== "string" || typeof value.pairing_id !== "string") throw new Error("PAIRING_BAD_RESPONSE");
  return value;
}

export async function pollCollectorPairing(adminUrl: string, pairing: CollectorPairingStart, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const response = await fetchImpl(`${adminUrl.replace(/\/$/u, "")}/admin/api/collector/pairings/${encodeURIComponent(pairing.pairing_id)}`, {
    headers: { authorization: `Pairing ${pairing.device_code}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 202) return undefined;
  const value = await responseJson<CollectorPairingPoll>(response);
  if (value.status !== "approved" || typeof value.api_key !== "string" || value.api_key.length === 0) throw new Error("PAIRING_BAD_RESPONSE");
  return value.api_key;
}

export async function waitForCollectorPairing(adminUrl: string, pairing: CollectorPairingStart, fetchImpl: typeof fetch = fetch): Promise<string> {
  const interval = Math.max(1000, Math.min(5000, pairing.interval_ms));
  while (Date.now() < pairing.expires_at) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const apiKey = await pollCollectorPairing(adminUrl, pairing, fetchImpl);
    if (apiKey !== undefined) return apiKey;
  }
  throw new Error("PAIRING_EXPIRED");
}
