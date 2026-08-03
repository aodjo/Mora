export interface Actor { type: "user" | "service"; id: string; permissions: string[] }
export interface AuthStatus { bootstrapped: boolean; actor: Actor | null }

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/admin/api${path}`, {
    credentials: "include",
    ...init,
    cache: init.cache ?? "no-store",
    signal: init.signal ?? AbortSignal.timeout(15_000),
    headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
  });
  const data = await response.json().catch(() => ({ error: "BAD_RESPONSE" })) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP_${response.status}`);
  return data;
}

export function liveEvents(onEvent: (event: unknown) => void): () => void {
  const source = new EventSource("/admin/api/events", { withCredentials: true });
  source.addEventListener("update", (event) => {
    try { onEvent(JSON.parse((event as MessageEvent<string>).data) as unknown); } catch { /* malformed server event */ }
  });
  return () => source.close();
}
