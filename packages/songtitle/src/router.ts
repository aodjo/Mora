import type {
  Provider,
  ProviderContext,
  ProviderOutcome,
  RouterResponse,
  SearchQuery,
} from "./types.js";
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
}

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
      const outcomes = await Promise.all(
        this.providers.map((p) => this.runOne(p, query, ctx)),
      );

      const results = outcomes
        .filter((o) => o.status === "ok" && o.result)
        .map((o) => o.result!);

      return { query, results, outcomes };
    } finally {
      await runner?.close();
    }
  }

  private async runOne(
    provider: Provider,
    query: SearchQuery,
    ctx: ProviderContext,
  ): Promise<ProviderOutcome> {
    // 키가 필요한데 없으면 스킵. 단, 브라우저 폴백이 가능하면 실행.
    const keyMissing =
      provider.requiresKey && provider.keyName && !ctx.keys[provider.keyName];
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
