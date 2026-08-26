import type { Provider, ProviderContext, ProviderOutcome, RouterResponse, SearchQuery } from "./types.js";
import { allProviders } from "./providers/index.js";
import { createBrowserRunner, type BrowserOptions, type BrowserRunner } from "./browser.js";

export interface RouterOptions {
  /** 사용할 프로바이더 (기본: 전체) */
  providers?: Provider[];
  /** API 키 모음 (기본: 환경변수에서 로드) */
  keys?: Record<string, string | undefined>;
  /** 프로바이더별 요청 타임아웃(ms, 기본 12000) */
  timeoutMs?: number;
  /** fetch 구현 주입 (테스트/프록시용, 기본 global fetch) */
  fetchImpl?: typeof fetch;
  /**
   * 브라우저(Chromium) 폴백 활성화.
   * HTTP로 못 가져오는 프로바이더(genius/lyricfind/shazam)를 헤드리스 브라우저로 크롤링.
   * true 또는 BrowserOptions 객체를 넘기면 켜짐 (기본 false).
   */
  browser?: boolean | BrowserOptions;
  /** 죽은 프로바이더 경고를 생성 시 출력 (기본 true, 테스트에서 끔) */
  warnOnDeadProviders?: boolean;
}

/** 프로바이더가 지금 이 설정에서 실제로 동작할 수 있는지 */
export interface ProviderAvailability {
  provider: string;
  /** 한 번이라도 시도할 수 있으면 true */
  live: boolean;
  /** live가 false인 이유 (설정으로 고칠 수 있는 말로) */
  reason?: string | undefined;
}

/**
 * 지금 설정에서 어떤 프로바이더가 살아 있는지.
 *
 * genius·lyricfind·shazam은 수집 이래 가사를 한 줄도 못 가져왔는데, 그 사실이
 * 어디에도 드러나지 않았다. 라우터는 `skipped`를 outcomes에 적어 두었지만
 * 호출부는 results만 읽고 outcomes를 버렸고, 브라우저 없는 shazam은 `not_found`와
 * 구분되지 않았다 — "이 곡에 가사가 없다"와 "이 프로바이더는 죽어 있다"가
 * 같은 모양이었다. 그래서 건너뛴 107곡 중 99곡이 no-lyrics로 남았다.
 */
export function describeAvailability(
  providers: readonly Provider[],
  keys: Record<string, string | undefined>,
  browserEnabled: boolean,
): ProviderAvailability[] {
  return providers.map((p) => {
    if (p.requiresKey && p.keyName && !keys[p.keyName]) {
      const viaBrowser = browserEnabled && p.browserCapable;
      if (!viaBrowser) return { provider: p.name, live: false, reason: `${p.keyName} 미설정` };
    }
    if (p.needsBrowser && !browserEnabled) {
      return { provider: p.name, live: false, reason: "SONGTITLE_BROWSER 미설정 (브라우저 없이는 동작 불가)" };
    }
    return { provider: p.name, live: true };
  });
}

/** 같은 경고를 매 라우터마다 반복해서 찍지 않도록 */
const warned = new Set<string>();

/**
 * 모든 프로바이더를 병렬로 호출해 가사를 "전부" 모으는 라우터.
 * 한 프로바이더가 실패해도 나머지에 영향 없음 (개별 격리).
 */
export class LyricsRouter {
  private readonly providers: Provider[];
  private readonly keys: Record<string, string | undefined>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly browserOpt: boolean | BrowserOptions;

  constructor(opts: RouterOptions = {}) {
    this.providers = opts.providers ?? allProviders;
    this.keys = opts.keys ?? loadKeysFromEnv();
    this.timeoutMs = opts.timeoutMs ?? 12_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.browserOpt = opts.browser ?? false;
    if (opts.warnOnDeadProviders !== false) this.warnOnDead();
  }

  /** 지금 설정에서 각 프로바이더가 동작 가능한지 */
  availability(): ProviderAvailability[] {
    return describeAvailability(this.providers, this.keys, this.browserEnabled);
  }

  /**
   * 죽은 프로바이더를 시작 시점에 한 번 알린다. 곡마다 조용히 실패하면
   * 아무도 눈치채지 못한다 — 실제로 아무도 눈치채지 못했다.
   */
  private warnOnDead(): void {
    const dead = this.availability().filter((a) => !a.live);
    if (dead.length === 0) return;
    const line = dead.map((a) => `${a.provider}(${a.reason})`).join(", ");
    if (warned.has(line)) return;
    warned.add(line);
    console.warn(`[songtitle] 동작하지 않는 프로바이더 ${dead.length}개: ${line}`);
  }

  private get browserEnabled(): boolean {
    return this.browserOpt !== false;
  }

  /** 등록된 프로바이더 이름 목록 */
  list(): string[] {
    return this.providers.map((p) => p.name);
  }

  /** 모든 프로바이더에서 가사를 병렬 수집 */
  async fetchAll(query: SearchQuery, signal?: AbortSignal): Promise<RouterResponse> {
    const runner: BrowserRunner | undefined = this.browserEnabled
      ? createBrowserRunner(typeof this.browserOpt === "object" ? this.browserOpt : {})
      : undefined;

    const ctx: ProviderContext = {
      keys: this.keys,
      timeoutMs: this.timeoutMs,
      signal,
      fetchImpl: this.fetchImpl,
      browser: runner,
    };

    try {
      const outcomes = await Promise.all(this.providers.map((p) => this.runOne(p, query, ctx)));

      const results = outcomes.filter((o) => o.status === "ok" && o.result).map((o) => o.result!);

      return { query, results, outcomes };
    } finally {
      await runner?.close();
    }
  }

  private async runOne(provider: Provider, query: SearchQuery, ctx: ProviderContext): Promise<ProviderOutcome> {
    // 키가 필요한데 없으면 스킵. 단, 브라우저 폴백이 가능하면 실행.
    const keyMissing = provider.requiresKey && provider.keyName && !ctx.keys[provider.keyName];
    const browserFallback = Boolean(ctx.browser && provider.browserCapable);
    if (keyMissing && !browserFallback) {
      return {
        provider: provider.name,
        status: "skipped",
        error: `missing ${provider.keyName}`,
        elapsedMs: 0,
      };
    }

    const started = Date.now();
    try {
      const result = await provider.fetch(query, ctx);
      const elapsedMs = Date.now() - started;
      if (!result || !result.lyrics.trim()) {
        return { provider: provider.name, status: "not_found", elapsedMs };
      }
      return { provider: provider.name, status: "ok", result, elapsedMs };
    } catch (err) {
      return {
        provider: provider.name,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        elapsedMs: Date.now() - started,
      };
    }
  }
}

/** 환경변수에서 알려진 키들을 로드 */
export function loadKeysFromEnv(): Record<string, string | undefined> {
  return {
    GENIUS_ACCESS_TOKEN: process.env.GENIUS_ACCESS_TOKEN,
    LYRICFIND_API_KEY: process.env.LYRICFIND_API_KEY,
    LYRICFIND_TERRITORY: process.env.LYRICFIND_TERRITORY,
  };
}
