export interface Actor {
  type: "user" | "service";
  id: string;
  permissions: string[];
}
export interface AuthStatus {
  bootstrapped: boolean;
  actor: Actor | null;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/admin/api${path}`, {
    credentials: "include",
    ...init,
    cache: init.cache ?? "no-store",
    signal: init.signal ?? AbortSignal.timeout(15_000),
    headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
  });
  const data = (await response.json().catch(() => ({ error: "BAD_RESPONSE" }))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP_${response.status}`);
  return data;
}

/**
 * Keeps the screen current.
 *
 * This was a server-sent stream, and holding one open kept a Durable Object awake for as long
 * as the console was — a tab left open on a desk spent the whole allowance, and when it ran
 * out every write that reported progress failed with it. Asking again on a timer costs one
 * request and no object that has to stay awake, and the screen is a few seconds behind at
 * worst, which is nothing next to the minutes a song takes to process.
 */
export function liveEvents(onEvent: () => void, everyMs = 5_000): () => void {
  const timer = window.setInterval(() => {
    // 탭이 뒤에 있으면 아무도 보고 있지 않다.
    if (document.visibilityState === "visible") onEvent();
  }, everyMs);
  const onVisible = (): void => {
    if (document.visibilityState === "visible") onEvent();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
