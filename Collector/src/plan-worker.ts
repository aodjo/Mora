import type { RecordingSeed } from "./types.js";

const IDLE_POLL_MS = 5_000;
const BACKOFF_MS = 20_000;

export type CollectionWork =
  | { kind: "collect"; id: string; artist: string; title: string; market: RecordingSeed["market"] }
  | { kind: "discover"; want: number }
  | { kind: "idle" };

export interface PlanWorkerOptions {
  adminUrl: string;
  adminToken: string;
  /** Walk the charts and return what is worth collecting, most wanted first. */
  discover: (want: number) => Promise<RecordingSeed[]>;
  /** Collect one song. Throwing marks it failed rather than losing it. */
  collect: (seed: RecordingSeed) => Promise<void>;
  fetch?: typeof globalThis.fetch;
  onLog?: (message: string) => void;
  signal?: AbortSignal;
  pollMs?: number;
}

/**
 * Takes work from the shared queue instead of deciding for itself.
 *
 * Each Collector used to walk the charts on start and spend its own budget, so three of them
 * did the same work three times over and the console had no say in how much got collected.
 * The console sets one total; the server holds the queue; this asks what to do next. Filling
 * the queue is a job like any other, held by whichever Collector claimed it, so the charts
 * are read once however many are running.
 */
export function startPlanWorker(options: PlanWorkerOptions): () => void {
  const fetcher = options.fetch ?? fetch;
  const base = options.adminUrl.replace(/\/$/u, "");
  const headers = { authorization: `Bearer ${options.adminToken}`, "content-type": "application/json" };
  let stopped = false;
  let wake: (() => void) | undefined;
  let waiting = false;
  const stop = (): void => {
    stopped = true;
    wake?.();
  };
  options.signal?.addEventListener("abort", stop, { once: true });

  void (async () => {
    while (!stopped) {
      let waited = options.pollMs ?? IDLE_POLL_MS;
      try {
        const response = await fetcher(`${base}/admin/api/collector/work/claim`, { method: "POST", headers, body: "{}" });
        if (!response.ok) throw new Error(`WORK_CLAIM_${response.status}`);
        const work = ((await response.json()) as { work?: CollectionWork }).work ?? { kind: "idle" };
        if (work.kind !== "idle") waiting = false;
        if (work.kind === "discover") {
          await fill(work.want);
          waited = 0;
        } else if (work.kind === "collect") {
          await handle(work);
          waited = 0;
        } else if (!waiting) {
          waiting = true;
          options.onLog?.("수집 대기 중: 어드민이 목표를 올리면 다시 시작합니다.");
        }
      } catch (error) {
        options.onLog?.(`수집 대기 실패: ${error instanceof Error ? error.message : "UNKNOWN"}`);
        waited = BACKOFF_MS;
      }
      if (waited > 0 && !stopped) await sleep(waited);
    }
  })();

  async function fill(want: number): Promise<void> {
    options.onLog?.(`차트를 훑어 대기열을 채웁니다 (${want}곡 필요)`);
    let songs: RecordingSeed[] = [];
    try {
      songs = await options.discover(want);
    } catch (error) {
      options.onLog?.(`차트 수집 실패: ${error instanceof Error ? error.message : "UNKNOWN"}`);
    }
    const response = await fetcher(`${base}/admin/api/collector/work/fill`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        songs: songs.map((seed) => ({ artist: seed.artist, title: seed.title, market: seed.market, priority: seed.popularity })),
      }),
    }).catch(() => undefined);
    const queued = response === undefined ? undefined : ((await response.json().catch(() => ({}))) as { queued?: number }).queued;
    options.onLog?.(`대기열 ${queued ?? "?"}곡`);
  }

  async function handle(work: { id: string; artist: string; title: string; market: RecordingSeed["market"] }): Promise<void> {
    let failure: string | undefined;
    try {
      await options.collect({ artist: work.artist, title: work.title, popularity: 1, freshness: 0, market: work.market });
    } catch (error) {
      failure = error instanceof Error ? error.message : "COLLECT_FAILED";
    }
    await fetcher(`${base}/admin/api/collector/work/${encodeURIComponent(work.id)}`, {
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
