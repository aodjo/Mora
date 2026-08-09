import type { RecordingSeed } from "./types.js";
import { decodeHtml } from "./html.js";

type Market = RecordingSeed["market"];

/**
 * What is actually on the charts, from the charts.
 *
 * Discovery used to pool ListenBrainz listen counts with every MusicBrainz release of the
 * last fortnight, and the fortnight is what filled runs with noise: a market's "fresh" feed
 * is every album anyone released anywhere, so runs opened with hobby releases nobody will
 * search for while the songs people wanted sat behind them. A chart is the answer to
 * exactly the question we are asking — what are people listening to this week — so the
 * chart is the source, and rank is the popularity.
 */

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:153.0) Gecko/20100101 Firefox/153.0";

/** Melon's TOP100 — the definitive KR chart. Served as HTML and only to things shaped like browsers. */
export async function melonTop100(fetcher: typeof fetch = fetch): Promise<RecordingSeed[]> {
  const response = await fetcher("https://www.melon.com/chart/index.htm", { headers: { "user-agent": BROWSER_UA } });
  if (!response.ok) throw new Error(`MELON_CHART_${response.status}`);
  const page = await response.text();
  const rows = page.matchAll(
    /<div class="ellipsis rank01">.*?<a href="[^"]*"[^>]*title="[^"]*"[^>]*>([^<]+)<\/a>.*?<div class="ellipsis rank02">.*?<a href="[^"]*"[^>]*>([^<]+)<\/a>/gsu,
  );
  const seeds: RecordingSeed[] = [];
  for (const row of rows) {
    const title = decodeHtml(row[1] ?? "");
    const artist = decodeHtml(row[2] ?? "");
    if (title.length === 0 || artist.length === 0) continue;
    seeds.push(seed(artist, title, "KR", seeds.length));
  }
  if (seeds.length === 0) throw new Error("MELON_CHART_EMPTY");
  return rerank(seeds);
}

/** Apple's most-played feed: one keyless JSON per storefront, and it exists for every market we run. */
export async function appleMostPlayed(market: Market, fetcher: typeof fetch = fetch): Promise<RecordingSeed[]> {
  const storefront = market.toLowerCase();
  const response = await fetcher(`https://rss.marketingtools.apple.com/api/v2/${storefront}/music/most-played/100/songs.json`);
  if (!response.ok) throw new Error(`APPLE_CHART_${response.status}`);
  const payload = (await response.json()) as { feed?: { results?: Array<{ name?: string; artistName?: string }> } };
  const seeds: RecordingSeed[] = [];
  for (const row of payload.feed?.results ?? []) {
    if (typeof row.name !== "string" || typeof row.artistName !== "string") continue;
    seeds.push(seed(row.artistName, row.name, market, seeds.length));
  }
  return rerank(seeds);
}

/** Every chart that speaks for the market. KR has a domestic authority; everywhere gets Apple. */
export async function chartSeeds(market: Market, fetcher: typeof fetch = fetch): Promise<RecordingSeed[]> {
  const boards = await Promise.all([
    appleMostPlayed(market, fetcher).catch(() => []),
    ...(market === "KR" ? [melonTop100(fetcher).catch(() => [])] : []),
  ]);
  return boards.flat();
}

function seed(artist: string, title: string, market: Market, rank: number): RecordingSeed {
  return { artist: artist.trim(), title: title.trim(), popularity: 1 - rank / 100, freshness: 0, market };
}

/** Popularity by final position, so a short chart still spans the full range. */
function rerank(seeds: RecordingSeed[]): RecordingSeed[] {
  return seeds.map((entry, index) => ({ ...entry, popularity: 1 - index / Math.max(1, seeds.length) }));
}
