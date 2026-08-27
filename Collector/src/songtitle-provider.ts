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

/**
 * Whether the credit the provider printed is the artist we asked about.
 *
 * A title on its own does not name a song. Melon answered サザンオールスターズ' "FRIENDS"
 * with Anne-Marie's — same word, different record — and the title check waved it through,
 * so a Japanese song was timed against English lyrics it does not contain.
 *
 * Credits are written loosely: "Anne-Marie", "Anne-Marie & Rudimental", "BTS (방탄소년단)",
 * "アイナ・ジ・エンド" for a member of a group. So this asks whether either name is inside
 * the other rather than whether they are equal, and a provider that prints no credit is
 * still trusted — the title check is what guards those.
 */
export function sameArtist(found: string | undefined, wanted: string): boolean {
  if (found === undefined) return true;
  const provided = normalizeTitle(found);
  const asked = normalizeTitle(wanted);
  if (provided.length === 0 || asked.length === 0) return true;
  if (provided.includes(asked) || asked.includes(provided)) return true;
  // 합작이면 크레딧이 "A & B", "A feat. B" 처럼 여럿을 이어 붙인다. 그중 하나만 맞아도 된다.
  const parts = (name: string): string[] =>
    name
      .split(/[,&·×]|\bfeat\.?\b|\bft\.?\b|\bwith\b|\band\b/giu)
      .map((piece) => normalizeTitle(piece))
      .filter((piece) => piece.length > 0);
  const mine = parts(wanted);
  const theirs = parts(found);
  if (mine.some((one) => theirs.some((other) => one.includes(other) || other.includes(one)))) return true;
  // 한 이름을 두 문자로 함께 적을 때, 어느 쪽을 앞에 두느냐는 서비스마다 다르다 —
  // "혁오 (HYUKOH)" 와 "HYUKOH(혁오)" 는 붙여 놓으면 "혁오hyukoh" 와 "hyukoh혁오"가 되어
  // 서로를 품지 못한다. 부르는 방식마다 따로 세면 순서가 문제되지 않는다.
  return spellings(wanted).some((one) => spellings(found).some((other) => one === other));
}

/**
 * 한 이름을 부르는 방식들 — 전체, 괄호 밖, 괄호 안.
 *
 * "혁오 (HYUKOH)" 는 혁오이기도 하고 HYUKOH 이기도 하다. 서로 다른 이름이 섞이지 않도록
 * 조각끼리 정확히 같을 때만 같은 이름으로 본다.
 */
function spellings(name: string): string[] {
  const inside = [...name.matchAll(/[（([［]([^）)\]］]+)[）)\]］]/gu)].map((match) => normalizeTitle(match[1] ?? ""));
  const outside = normalizeTitle(name.replace(/[（([［][^）)\]］]*[）)\]］]/gu, " "));
  return [normalizeTitle(name), outside, ...inside].filter((part) => part.length > 0);
}

function scriptCounts(text: string): { hangul: number; kana: number; han: number; latin: number; total: number } {
  const count = (pattern: RegExp) => (text.match(pattern) ?? []).length;
  const hangul = count(/\p{Script=Hangul}/gu);
  const kana = count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const han = count(/\p{Script=Han}/gu);
  const latin = count(/\p{Script=Latin}/gu);
  return { hangul, kana, han, latin, total: hangul + kana + han + latin };
}

/**
 * How much of a sheet a script has to cover before it names the language.
 *
 * Presence was the old rule, and one character decided a whole sheet. Genie's copy of Drake's
 * "Best I Ever Had" opens on the header "Best I Ever Had - Drake (드레이크)", and those four
 * Hangul characters — 0.15% of 2,600 — sent an English rap to the Korean recogniser. Sharing it
 * out tells that apart from a real K-pop lyric, which mixes English freely but not that freely:
 * the lowest in the collection is ATEEZ' "BAD" at 8% Hangul against 92% Latin. Anything between
 * the two works, and this sits in the middle of a gap fifty times wide.
 */
const ENOUGH_TO_NAME = 0.02;

export function inferLyricsLanguage(text: string): string | undefined {
  const { hangul, kana, han, latin, total } = scriptCounts(text);
  if (total === 0) return undefined;
  if (hangul / total >= ENOUGH_TO_NAME) return "ko";
  if (kana / total >= ENOUGH_TO_NAME) return "ja";
  if (latin > 0 && han === 0 && !/[\p{Script=Cyrillic}\p{Script=Arabic}]/u.test(text)) {
    return "en";
  }
  return undefined;
}

/**
 * A sheet that prints a reading guide and a translation under every line that is actually sung.
 *
 * Melon, Bugs and FLO serve Japanese songs to Korean readers three lines at a time — the
 * Japanese, then its pronunciation spelled in Hangul, then what it means. 米津玄師's "IRIS OUT"
 * arrives from Genie at 673 characters and from FLO at 2,387, and the extra 1,714 are never
 * voiced. The aligner cannot tell which third to listen for, so it spreads the song across all
 * three and every timing after the first line is wrong.
 *
 * No real lyric mixes the two scripts. Of 498 sheets collected, thirteen carry both Hangul and
 * kana above a tenth, and those thirteen are exactly the annotated ones — the lightest at 43%
 * Hangul over 14% kana, against a clean sheet's zero. All ten songs they belong to have an
 * unannotated copy from another provider, so refusing them costs no song its lyrics.
 *
 * A genuinely bilingual Korean-Japanese recording would be refused too. None exists in the
 * collection, and timing a song against a sheet that is two thirds unsung is the worse trade.
 */
export function isAnnotatedTranslation(text: string): boolean {
  const { hangul, kana, total } = scriptCounts(text);
  if (total === 0) return false;
  return hangul / total >= 0.1 && kana / total >= 0.1;
}

export class SongTitleLyricsProvider implements LyricsProvider {
  constructor(private readonly router: SongTitleRouter) {}

  async search(input: Parameters<LyricsProvider["search"]>[0]): Promise<LyricsProviderResult[]> {
    const response = await this.router.fetchAll({ title: input.title, artist: input.artist });
    const fetchedAt = Date.now();

    return response.results.flatMap((result): LyricsProviderResult[] => {
      if (result.lyrics.trim().length === 0) return [];
      if (!looksLikeLyrics(result.lyrics)) return [];
      if (isAnnotatedTranslation(result.lyrics)) return [];
      if (!sameSong(result.title, input.title)) return [];
      if (!sameArtist(result.artist, input.artist)) return [];
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
