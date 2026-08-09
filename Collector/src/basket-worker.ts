import type { CollectorService } from "./service.js";
import type { RecordingSeed } from "./types.js";

const IDLE_POLL_MS = 4_000;
const BACKOFF_MS = 20_000;

export interface BasketSong {
  id: string;
  artist: string;
  title: string;
  album?: string;
  duration_ms?: number;
  isrc?: string;
}

export interface BasketWorkerOptions {
  adminUrl: string;
  adminToken: string;
  collect: (seed: RecordingSeed) => Promise<void>;
  fetch?: typeof globalThis.fetch;
  onLog?: (message: string) => void;
  signal?: AbortSignal;
  pollMs?: number;
}

/**
 * Collects the songs a person put in the basket.
 *
 * These jump the chart queue by construction: someone asked for them by name, which is a
 * stronger signal than any chart position. Claiming works the way the search queue's does, so
 * several Collectors drain one basket without two of them fetching the same song.
 */
export function startBasketWorker(options: BasketWorkerOptions): () => void {
  const fetcher = options.fetch ?? fetch;
  const base = options.adminUrl.replace(/\/$/u, "");
  const headers = { authorization: `Bearer ${options.adminToken}`, "content-type": "application/json" };
  let stopped = false;
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
        const response = await fetcher(`${base}/admin/api/collector/basket/claim`, { method: "POST", headers, body: "{}" });
        if (!response.ok) throw new Error(`BASKET_CLAIM_${response.status}`);
        const song = ((await response.json()) as { song?: BasketSong | null }).song ?? null;
        if (song !== null) {
          await handle(song);
          waited = 0;
        }
      } catch (error) {
        options.onLog?.(`장바구니 대기 실패: ${error instanceof Error ? error.message : "UNKNOWN"}`);
        waited = BACKOFF_MS;
      }
      if (waited > 0 && !stopped) await sleep(waited);
    }
  })();

  async function handle(song: BasketSong): Promise<void> {
    options.onLog?.(`장바구니 수집: ${song.artist} - ${song.title}`);
    let failure: string | undefined;
    try {
      await options.collect({
        artist: song.artist,
        title: song.title,
        ...(song.album === undefined ? {} : { album: song.album }),
        ...(song.duration_ms === undefined ? {} : { duration_ms: song.duration_ms }),
        ...(song.isrc === undefined ? {} : { isrc: song.isrc }),
        // Asked for by name, so it outranks anything a chart put in the queue.
        popularity: 1,
        freshness: 0,
        market: "KR",
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : "COLLECT_FAILED";
      options.onLog?.(`장바구니 수집 실패 (${failure}): ${song.artist} - ${song.title}`);
    }
    await fetcher(`${base}/admin/api/collector/basket/${encodeURIComponent(song.id)}`, {
      method: "POST",
      headers,
      body: JSON.stringify(failure === undefined ? {} : { error: failure }),
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

/** The basket hands one song at a time to the same collection path the charts feed. */
export function collectOne(service: CollectorService): (seed: RecordingSeed) => Promise<void> {
  return async (seed) => {
    const report = await service.collect([seed]);
    const failure = report.errors[0];
    if (failure !== undefined) throw new Error(failure.code);
  };
}
