import type { Browser, Page } from "playwright";

export interface BrowserOptions {
  /** 헤드리스 여부 (기본 true). 봇 차단이 심한 사이트는 false가 더 잘 통함 */
  headless?: boolean;
  /** 페이지 이동/셀렉터 대기 타임아웃 (기본 30000) */
  navTimeoutMs?: number;
  /** UA 강제 지정 (기본: 브라우저 네이티브 UA를 그대로 사용 — 클라이언트 힌트와 일치시켜 탐지 회피) */
  userAgent?: string;
  locale?: string;
  args?: string[];
}

/** 프로바이더가 페이지 단위로 크롤링 작업을 실행하는 핸들 */
export interface BrowserRunner {
  /** 새 컨텍스트/페이지에서 fn 실행 후 정리. 브라우저는 재사용 */
  run<T>(fn: (page: Page) => Promise<T>): Promise<T>;
  /** 브라우저 종료 (라우터가 fetchAll 끝에 호출) */
  close(): Promise<void>;
}

interface Launcher {
  use?: (plugin: unknown) => void;
  launch: (opts: Record<string, unknown>) => Promise<Browser>;
}

/**
 * 헤드리스 탐지를 최대한 회피하는 Chromium 런처.
 * - playwright-extra + stealth 플러그인이 있으면 사용(webdriver/plugins/webgl 등 패치),
 *   없으면 순정 playwright로 폴백.
 * - `channel: "chromium"`(풀 Chromium new-headless)을 우선 시도 → UA/클라이언트 힌트가
 *   "HeadlessChrome"이 아니라 정상 "Chrome/Chromium"으로 나가 탐지가 크게 줄어든다.
 *   미설치 시 기본 headless-shell로 폴백.
 * - UA는 강제로 바꾸지 않는다(네이티브 UA와 Sec-CH-UA를 일치시켜 버전 불일치 탐지 방지).
 */
async function launchBrowser(headless: boolean, extraArgs: string[]): Promise<Browser> {
  const args = ["--no-sandbox", "--disable-blink-features=AutomationControlled", ...extraArgs];

  let launcher: Launcher;
  try {
    const extra = (await import("playwright-extra")) as unknown as { chromium: Launcher };
    const stealthMod = (await import("puppeteer-extra-plugin-stealth")) as unknown as {
      default: () => unknown;
    };
    extra.chromium.use?.(stealthMod.default());
    launcher = extra.chromium;
  } catch {
    const { chromium } = await import("playwright");
    launcher = chromium as unknown as Launcher;
  }

  try {
    return await launcher.launch({ channel: "chromium", headless, args });
  } catch {
    return await launcher.launch({ headless, args });
  }
}

export function createBrowserRunner(opts: BrowserOptions = {}): BrowserRunner {
  let browserPromise: Promise<Browser> | null = null;
  const headless = opts.headless ?? true;
  const locale = opts.locale ?? "ko-KR";
  const navTimeout = opts.navTimeoutMs ?? 30_000;

  // 여러 프로바이더가 하나의 브라우저를 공유하므로 run() 호출을 직렬화한다.
  // (동시에 여러 페이지를 열면 자원 경합으로 타임아웃이 난다)
  let queue: Promise<unknown> = Promise.resolve();

  async function getBrowser(): Promise<Browser> {
    if (!browserPromise) {
      browserPromise = launchBrowser(headless, opts.args ?? []);
    }
    return browserPromise;
  }

  async function runExclusive<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const browser = await getBrowser();
    const context = await browser.newContext({
      // userAgent 미지정 시 네이티브 UA 사용 (클라이언트 힌트와 일치)
      ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
      locale,
      viewport: { width: 1366, height: 900 },
    });
    // stealth 플러그인이 없을 때를 대비한 최소 방어 (userAgentData는 건드리지 않음 → 불일치 방지)
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(navTimeout);
    page.setDefaultNavigationTimeout(navTimeout);
    try {
      return await fn(page);
    } finally {
      await context.close().catch(() => {});
    }
  }

  return {
    run<T>(fn: (page: Page) => Promise<T>): Promise<T> {
      // 이전 작업이 끝난 뒤 실행 (직렬화). 실패해도 큐는 계속 진행.
      const result = queue.then(() => runExclusive(fn));
      queue = result.catch(() => {});
      return result;
    },

    async close(): Promise<void> {
      if (!browserPromise) return;
      const b = await browserPromise.catch(() => null);
      browserPromise = null;
      if (b) await b.close().catch(() => {});
    },
  };
}
