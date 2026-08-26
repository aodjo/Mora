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
    // ISRC 가 있으면 곡을 특정하는 일은 이미 끝났다. 그렇다고 여기서 돌아서면 이 곡이 어느
    // 앨범에 실렸는지도 함께 잃는다 — 앨범 확장은 release_mbid 에 얹혀 있고, 그것은 이
    // 조회에서만 나온다. 수집한 곡의 70% 가 ISRC 를 들고 들어오는 탓에 앨범 확장이 한 번도
    // 돈 적이 없었다. 차트는 앨범의 히트곡 하나만 이름 붙이므로, 그 나머지는 이 길이 아니면
    // 영영 오지 않는다.
    //
    // 실패해도 잃을 것이 없다. 곡은 이미 ISRC 로 특정되어 있고, 앨범을 못 찾으면 오늘까지와
    // 같아질 뿐이다. MusicBrainz 는 초당 한 번이라 곡마다 조회 하나가 늘지만, 수집은 곡당
    // 30 초쯤 걸리므로 그 안에 묻힌다.
    if (seed.isrc !== undefined) {
      const named = { ...seed, isrc: normalizeIsrc(seed.isrc) };
      const found = await this.byIsrc(named.isrc!).catch(() => undefined);
      return found === undefined ? named : { ...this.enrich(named, found), isrc: named.isrc };
    }
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

  /**
   * ISRC 로 곧장 찾는다 — 제목·아티스트로 검색해 점수를 매기는 것보다 정확하고 싸다.
   *
   * 한 ISRC 가 여러 녹음에 붙어 있을 수 있다. 그럴 때는 릴리스를 들고 있는 것을 고른다 —
   * 이 조회를 하는 이유가 앨범을 찾는 것이기 때문이다.
   */
  private async byIsrc(isrc: string): Promise<MbRecording | undefined> {
    const url = new URL(`https://musicbrainz.org/ws/2/isrc/${encodeURIComponent(isrc)}`);
    url.searchParams.set("fmt", "json");
    url.searchParams.set("inc", "releases");
    const response = await this.fetcher(url, { headers: { "user-agent": this.userAgent, accept: "application/json" } });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`MUSICBRAINZ_${response.status}`);
    const payload = (await response.json()) as { recordings?: MbRecording[] };
    const found = payload.recordings ?? [];
    return found.find((item) => (item.releases?.length ?? 0) > 0) ?? found[0];
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
