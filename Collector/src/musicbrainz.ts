import type { RecordingSeed } from "./types.js";

interface MbRecording {
  id?: string;
  title?: string;
  length?: number;
  isrcs?: string[];
  "artist-credit"?: Array<{ name?: string }>;
  releases?: Array<{ title?: string; date?: string }>;
  score?: number;
}

export class MusicBrainzClient {
  constructor(
    private readonly userAgent: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async identify(seed: RecordingSeed): Promise<RecordingSeed> {
    if (seed.isrc !== undefined) return { ...seed, isrc: normalizeIsrc(seed.isrc) };
    if (seed.mbid !== undefined) {
      const exact = await this.lookup(seed.mbid);
      if (exact !== undefined) return this.enrich(seed, exact);
    }
    const query = `recording:${JSON.stringify(seed.title)} AND artist:${JSON.stringify(seed.artist)}`;
    const url = new URL("https://musicbrainz.org/ws/2/recording/");
    url.searchParams.set("query", query);
    url.searchParams.set("fmt", "json");
    url.searchParams.set("limit", "5");
    const response = await this.fetcher(url, { headers: { "user-agent": this.userAgent, accept: "application/json" } });
    if (!response.ok) throw new Error(`MUSICBRAINZ_${response.status}`);
    const payload = (await response.json()) as { recordings?: MbRecording[] };
    const candidates = (payload.recordings ?? [])
      .map((item) => ({ item, score: this.score(seed, item) }))
      .sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (best === undefined || best.score < 0.88 || (candidates[1] !== undefined && best.score - candidates[1].score < 0.05)) return seed;
    const item =
      best.item.isrcs?.[0] !== undefined || best.item.id === undefined ? best.item : ((await this.lookup(best.item.id)) ?? best.item);
    return this.enrich(seed, item);
  }

  async fresh(market: "KR" | "US" | "JP", days = 14, limit = 100): Promise<RecordingSeed[]> {
    const end = new Date();
    const start = new Date(end.getTime() - days * 86_400_000);
    const date = (value: Date) => value.toISOString().slice(0, 10);
    const url = new URL("https://musicbrainz.org/ws/2/recording/");
    url.searchParams.set("query", `firstreleasedate:[${date(start)} TO ${date(end)}] AND country:${market}`);
    url.searchParams.set("fmt", "json");
    url.searchParams.set("limit", String(Math.min(100, limit)));
    const response = await this.fetcher(url, { headers: { "user-agent": this.userAgent, accept: "application/json" } });
    if (!response.ok) throw new Error(`MUSICBRAINZ_${response.status}`);
    const payload = (await response.json()) as { recordings?: MbRecording[] };
    return (payload.recordings ?? []).flatMap((item): RecordingSeed[] => {
      const artist = item["artist-credit"]
        ?.map((x) => x.name)
        .filter(Boolean)
        .join("");
      if (!item.title || !artist) return [];
      return [
        {
          artist,
          title: item.title,
          album: item.releases?.[0]?.title,
          duration_ms: item.length,
          mbid: item.id,
          isrc: item.isrcs?.[0],
          popularity: 0,
          freshness: 1,
          market,
        },
      ];
    });
  }

  private score(seed: RecordingSeed, item: MbRecording): number {
    const normalize = (value: string) =>
      value
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "");
    const title = normalize(seed.title) === normalize(item.title ?? "") ? 1 : 0;
    const artist = normalize(seed.artist) === normalize(item["artist-credit"]?.map((x) => x.name ?? "").join("") ?? "") ? 1 : 0;
    const duration =
      seed.duration_ms === undefined || item.length === undefined
        ? 0.5
        : Math.max(0, 1 - Math.abs(seed.duration_ms - item.length) / 10_000);
    return title * 0.45 + artist * 0.4 + duration * 0.15;
  }

  private async lookup(mbid: string): Promise<MbRecording | undefined> {
    const url = new URL(`https://musicbrainz.org/ws/2/recording/${encodeURIComponent(mbid)}`);
    url.searchParams.set("fmt", "json");
    url.searchParams.set("inc", "isrcs+releases");
    const response = await this.fetcher(url, { headers: { "user-agent": this.userAgent, accept: "application/json" } });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`MUSICBRAINZ_${response.status}`);
    return (await response.json()) as MbRecording;
  }

  private enrich(seed: RecordingSeed, item: MbRecording): RecordingSeed {
    const isrc = item.isrcs?.[0];
    return {
      ...seed,
      ...(item.id === undefined ? {} : { mbid: item.id }),
      ...(isrc === undefined ? {} : { isrc: normalizeIsrc(isrc) }),
      duration_ms: item.length ?? seed.duration_ms,
      album: seed.album ?? item.releases?.[0]?.title,
    };
  }
}

function normalizeIsrc(value: string): string {
  return value.replaceAll("-", "").toUpperCase();
}
