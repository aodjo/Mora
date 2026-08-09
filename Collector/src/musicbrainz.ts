import type { RecordingSeed } from "./types.js";

interface MbRecording {
  id?: string;
  title?: string;
  length?: number;
  isrcs?: string[];
  "artist-credit"?: Array<{ name?: string; joinphrase?: string }>;
  releases?: Array<{ id?: string; title?: string; date?: string }>;
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

  private score(seed: RecordingSeed, item: MbRecording): number {
    const normalize = (value: string) =>
      value
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "");
    const title = normalize(seed.title) === normalize(item.title ?? "") ? 1 : 0;
    const artist = normalize(seed.artist) === normalize(creditedArtist(item)) ? 1 : 0;
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
    const release = item.releases?.[0];
    return {
      ...seed,
      ...(item.id === undefined ? {} : { mbid: item.id }),
      ...(isrc === undefined ? {} : { isrc: normalizeIsrc(isrc) }),
      duration_ms: item.length ?? seed.duration_ms,
      album: seed.album ?? release?.title,
      ...(release?.id === undefined ? {} : { release_mbid: release.id }),
    };
  }

  /**
   * Everything else on the release a song came from. A chart names an album's one hit; the
   * rest of that album is music people will search for that no chart will ever surface.
   */
  async albumTracks(releaseMbid: string): Promise<Array<{ artist: string; title: string; mbid?: string }>> {
    const url = new URL(`https://musicbrainz.org/ws/2/release/${encodeURIComponent(releaseMbid)}`);
    url.searchParams.set("fmt", "json");
    url.searchParams.set("inc", "recordings+artist-credits");
    const response = await this.fetcher(url, { headers: { "user-agent": this.userAgent, accept: "application/json" } });
    if (!response.ok) throw new Error(`MUSICBRAINZ_${response.status}`);
    const payload = (await response.json()) as {
      media?: Array<{ tracks?: Array<{ title?: string; "artist-credit"?: MbRecording["artist-credit"]; recording?: { id?: string } }> }>;
    };
    const tracks: Array<{ artist: string; title: string; mbid?: string }> = [];
    for (const medium of payload.media ?? []) {
      for (const track of medium.tracks ?? []) {
        if (typeof track.title !== "string" || track.title.length === 0) continue;
        const artist = creditedArtist({ "artist-credit": track["artist-credit"] ?? [] });
        if (artist.length === 0) continue;
        tracks.push({ artist, title: track.title, ...(track.recording?.id === undefined ? {} : { mbid: track.recording.id }) });
      }
    }
    return tracks;
  }
}

/**
 * MusicBrainz splits a credit into parts and carries the separator in joinphrase. Concatenating
 * only the names ran them together — "SHIFT UP" + "Youngjee Lee" became "SHIFT UPYoungjee Lee",
 * which then went out as the search query and matched nothing.
 */
function creditedArtist(item: MbRecording): string {
  return (item["artist-credit"] ?? [])
    .map((part) => `${part.name ?? ""}${part.joinphrase ?? ""}`)
    .join("")
    .trim();
}

function normalizeIsrc(value: string): string {
  return value.replaceAll("-", "").toUpperCase();
}
