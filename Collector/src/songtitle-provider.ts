import {
  LyricsRouter,
  providerByName,
  type BrowserOptions,
  type LyricsResult,
  type RouterResponse,
  type SearchQuery,
} from "@mora/songtitle";
import type { LyricsProvider, LyricsProviderResult } from "../../packages/contracts/src/index.js";

export interface SongTitleRouter {
  fetchAll(query: SearchQuery, signal?: AbortSignal): Promise<RouterResponse>;
}

export interface SongTitleProviderOptions {
  providers?: string[];
  timeoutMs?: number;
  browser?: boolean | BrowserOptions;
  keys?: Record<string, string | undefined>;
}

function providerReference(result: LyricsResult): string | undefined {
  if (result.url !== undefined && result.url.length > 0) return result.url;
  if (result.trackId !== undefined && result.trackId.length > 0) {
    return `${result.provider}:${result.trackId}`;
  }
  return undefined;
}

/**
 * What a provider serves in place of lyrics when it has none. Stored verbatim it is
 * indistinguishable from a successful fetch, so the no-lyrics skip never fired: 36 recordings
 * carry Bugs' "가사 준비 중입니다" panel and 35 carry Genie's "가사 정보가 없습니다".
 */
const NOT_LYRICS = [
  /가사\s*준비\s*중/u,
  /가사\s*정보가\s*없/u,
  /등록된?\s*가사가?\s*없/u,
  /가사가\s*없습니다/u,
  /청소년\s*보호법/u,
  /성인\s*인증/u,
  /lyrics?\s+(?:are\s+)?(?:not\s+available|unavailable)/iu,
  /no\s+lyrics\s+found/iu,
];

/** A notice leads the page; real lyrics never open with one. */
export function looksLikeLyrics(text: string): boolean {
  const head = text.trim().slice(0, 120);
  return head.length > 0 && !NOT_LYRICS.some((pattern) => pattern.test(head));
}

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Whether the provider answered about the song we asked for. Melon returned one Latin lyric for
 * 88 different recordings — searching by title and artist is a best-effort match on their side,
 * and an unchecked one lands the wrong words under a song that would then be timed against them.
 * Genie and Vibe echo the query back as the title, so there is nothing to disagree with and the
 * notice check above is what guards them.
 */
export function sameSong(found: string | undefined, wanted: string): boolean {
  if (found === undefined) return true;
  const provided = normalizeTitle(found);
  const asked = normalizeTitle(wanted);
  if (provided.length === 0 || asked.length === 0) return true;
  return provided.includes(asked) || asked.includes(provided);
}

export function inferLyricsLanguage(text: string): string | undefined {
  if (/\p{Script=Hangul}/u.test(text)) return "ko";
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "ja";
  if (/\p{Script=Latin}/u.test(text) && !/[\p{Script=Han}\p{Script=Cyrillic}\p{Script=Arabic}]/u.test(text)) {
    return "en";
  }
  return undefined;
}

export class SongTitleLyricsProvider implements LyricsProvider {
  constructor(private readonly router: SongTitleRouter) {}

  async search(input: Parameters<LyricsProvider["search"]>[0]): Promise<LyricsProviderResult[]> {
    const response = await this.router.fetchAll({ title: input.title, artist: input.artist });
    const fetchedAt = Date.now();

    return response.results.flatMap((result): LyricsProviderResult[] => {
      if (result.lyrics.trim().length === 0) return [];
      if (!looksLikeLyrics(result.lyrics)) return [];
      if (!sameSong(result.title, input.title)) return [];
      const reference = providerReference(result);
      const language = inferLyricsLanguage(result.lyrics);
      return [
        {
          provider: result.provider,
          ...(reference === undefined ? {} : { provider_ref: reference }),
          text: result.lyrics,
          ...(language === undefined ? {} : { language }),
          fetched_at: fetchedAt,
        },
      ];
    });
  }
}

export function createSongTitleProvider(options: SongTitleProviderOptions = {}): LyricsProvider {
  const configuredNames = options.providers?.map((name) => name.trim().toLowerCase()).filter(Boolean);
  const names = configuredNames !== undefined && configuredNames.length > 0 ? [...new Set(configuredNames)] : undefined;
  const providers = names?.map((name) => providerByName[name]);
  const unknown = names?.filter((_, index) => providers?.[index] === undefined) ?? [];
  if (unknown.length > 0) throw new Error(`Unknown SongTitle providers: ${unknown.join(", ")}`);

  return new SongTitleLyricsProvider(
    new LyricsRouter({
      ...(providers === undefined ? {} : { providers: providers.filter((item) => item !== undefined) }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.browser === undefined ? {} : { browser: options.browser }),
      ...(options.keys === undefined ? {} : { keys: options.keys }),
    }),
  );
}

function enabled(value: string | undefined): boolean {
  return value !== undefined && /^(?:1|true|yes|on)$/iu.test(value);
}

export function createSongTitleProviderFromEnv(env: NodeJS.ProcessEnv = process.env): LyricsProvider {
  const timeoutMs = env.SONGTITLE_TIMEOUT_MS === undefined ? undefined : Number(env.SONGTITLE_TIMEOUT_MS);
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error("SONGTITLE_TIMEOUT_MS must be a positive number");
  }

  const browser = enabled(env.SONGTITLE_BROWSER) ? { headless: !enabled(env.SONGTITLE_HEADFUL) } : false;
  const providers = env.SONGTITLE_PROVIDERS?.split(",");
  return createSongTitleProvider({
    ...(providers === undefined ? {} : { providers }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    browser,
    keys: {
      GENIUS_ACCESS_TOKEN: env.GENIUS_ACCESS_TOKEN,
      LYRICFIND_API_KEY: env.LYRICFIND_API_KEY,
      LYRICFIND_TERRITORY: env.LYRICFIND_TERRITORY,
    },
  });
}
