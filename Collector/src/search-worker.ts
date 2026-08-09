import { searchYoutube, type YoutubeSearchResult } from "./youtube.js";

const IDLE_POLL_MS = 1_500;
const BACKOFF_MS = 15_000;

export interface SearchWorkerOptions {
  adminUrl: string;
  adminToken: string;
  fetch?: typeof globalThis.fetch;
  search?: (query: string, limit?: number) => Promise<YoutubeSearchResult[]>;
  onLog?: (message: string) => void;
  signal?: AbortSignal;
  pollMs?: number;
}

interface ClaimResponse {
  request?: { id: string; query: string } | null;
}

/**
 * Answers the console's audio searches.
 *
 * The Worker cannot run yt-dlp and every Collector can, so the console leaves the query on the
 * server and the Collectors race for it. Claiming is the write itself, so the one that gets
 * there first owns it — which is the one that had time to ask. Whether it is the same machine
 * as the console is not something the console should have to know.
 */
export function startSearchWorker(options: SearchWorkerOptions): () => void {
  const fetcher = options.fetch ?? fetch;
  const search = options.search ?? searchYoutube;
  const base = options.adminUrl.replace(/\/$/u, "");
  const headers = { authorization: `Bearer ${options.adminToken}`, "content-type": "application/json" };
  let stopped = false;
  // Held so stopping cuts the wait short instead of leaving the process alive for a backoff.
  let wake: (() => void) | undefined;
  const stop = (): void => {
    stopped = true;
    wake?.();
  };
  options.signal?.addEventListener("abort", stop, { once: true });

  void (async () => {
    while (!stopped) {
      let waited = options.pollMs ?? IDLE_POLL_MS;
      try {
        const response = await fetcher(`${base}/admin/api/collector/searches/claim`, { method: "POST", headers, body: "{}" });
        if (!response.ok) throw new Error(`CLAIM_${response.status}`);
        const claimed = ((await response.json()) as ClaimResponse).request ?? null;
        if (claimed !== null) {
          await answer(claimed);
          waited = 0; // 큐가 밀려 있을 수 있으니 곧바로 다음 요청을 본다.
        }
      } catch (error) {
        // 서버가 잠깐 없거나 권한이 없는 상태로 계속 두드리지 않는다.
        options.onLog?.(`검색 대기 실패: ${error instanceof Error ? error.message : "UNKNOWN"}`);
        waited = BACKOFF_MS;
      }
      if (waited > 0 && !stopped) await sleep(waited);
    }
  })();

  async function answer(request: { id: string; query: string }): Promise<void> {
    let payload: Record<string, unknown>;
    try {
      payload = { items: await search(request.query, 20) };
    } catch (error) {
      payload = { error: error instanceof Error ? error.message : "SEARCH_FAILED" };
    }
    await fetcher(`${base}/admin/api/collector/searches/${encodeURIComponent(request.id)}`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }).catch(() => undefined);
  }

  return stop;

  function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(finish, milliseconds);
      wake = finish;
      function finish(): void {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      }
    });
  }
}
