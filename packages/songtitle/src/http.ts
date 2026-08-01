/** 브라우저 유사 User-Agent — 다수 서비스가 봇 차단하므로 기본 헤더로 사용 */
export const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface HttpOptions {
  headers?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * 타임아웃과 외부 AbortSignal을 함께 지원하는 GET.
 * 응답이 2xx가 아니면 throw 한다.
 */
export async function httpGet(url: string, opts: HttpOptions): Promise<Response> {
  const f = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), opts.timeoutMs);
  const onAbort = () => ctrl.abort(opts.signal?.reason);

  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort(opts.signal.reason);
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const res = await f(url, {
      headers: {
        "User-Agent": DEFAULT_UA,
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
        ...opts.headers,
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    return res;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

export async function getText(url: string, opts: HttpOptions): Promise<string> {
  return (await httpGet(url, opts)).text();
}

/** content-type을 신뢰하지 않고 text→JSON.parse (일부 API가 잘못된 헤더를 보냄) */
export async function getJson<T = unknown>(url: string, opts: HttpOptions): Promise<T> {
  const text = await getText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`invalid JSON from ${url}`);
  }
}
