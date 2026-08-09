import type { RecordingSeed } from "./types.js";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const SEARCH_URL = "https://api.spotify.com/v1/search";

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}
interface SpotifyTrack {
  name?: string;
  duration_ms?: number;
  artists?: Array<{ name?: string }>;
  album?: { name?: string; images?: Array<{ url?: string }> };
  external_ids?: { isrc?: string };
}
interface SearchResponse {
  tracks?: { items?: SpotifyTrack[] };
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * MusicBrainz carries no ISRC for a third of what the collector finds, which is most of the
 * Korean catalogue, and the server cannot open a job without one. Spotify is queried only to
 * fill that gap: it never overrides an identifier we already have.
 */
export class SpotifyClient {
  #token: { value: string; expiresAt: number } | undefined;

  /** Until when Spotify has told us to go away. Asking again sooner only extends the ban. */
  #blockedUntil = 0;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly onLog?: (message: string) => void,
  ) {}

  /** Milliseconds left on a rate-limit block, or 0 when Spotify is answering. */
  get blockedForMs(): number {
    return Math.max(0, this.#blockedUntil - Date.now());
  }

  #noteRateLimit(response: Response): void {
    const retryAfter = Number(response.headers.get("retry-after") ?? 600);
    this.#blockedUntil = Date.now() + Math.max(60, retryAfter) * 1000;
    const hours = (this.#blockedUntil - Date.now()) / 3_600_000;
    this.onLog?.(
      `Spotify 요청 한도를 넘었습니다. ${hours >= 1 ? `약 ${hours.toFixed(1)}시간` : `${Math.ceil(hours * 60)}분`} 동안 Spotify 없이 진행합니다 (ISRC·카탈로그 길이 보강이 빠집니다).`,
    );
  }

  async #accessToken(): Promise<string> {
    if (this.#token !== undefined && this.#token.expiresAt > Date.now()) return this.#token.value;
    const response = await this.fetcher(TOKEN_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (response.status === 429) {
      this.#noteRateLimit(response);
      throw new Error("SPOTIFY_RATE_LIMITED");
    }
    if (!response.ok) throw new Error(`SPOTIFY_TOKEN_${response.status}`);
    const payload = (await response.json()) as TokenResponse;
    if (typeof payload.access_token !== "string") throw new Error("SPOTIFY_TOKEN_MALFORMED");
    // Renew a minute early rather than racing the expiry.
    this.#token = { value: payload.access_token, expiresAt: Date.now() + Math.max(60, (payload.expires_in ?? 3600) - 60) * 1000 };
    return this.#token.value;
  }

  async #search(query: string): Promise<SpotifyTrack[]> {
    const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&type=track&limit=5`;
    const response = await this.fetcher(url, { headers: { authorization: `Bearer ${await this.#accessToken()}` } });
    if (response.status === 429) {
      this.#noteRateLimit(response);
      throw new Error("SPOTIFY_RATE_LIMITED");
    }
    if (!response.ok) throw new Error(`SPOTIFY_SEARCH_${response.status}`);
    return ((await response.json()) as SearchResponse).tracks?.items ?? [];
  }

  /** Free-text search for the console: candidates for these words, not a verdict. */
  async searchTracks(
    query: string,
    limit = 20,
  ): Promise<Array<{ title: string; artist: string; album?: string; durationMs?: number; isrc?: string; artwork?: string }>> {
    if (this.blockedForMs > 0) return [];
    const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&type=track&limit=${Math.min(50, limit)}`;
    const response = await this.fetcher(url, { headers: { authorization: `Bearer ${await this.#accessToken()}` } });
    if (response.status === 429) {
      this.#noteRateLimit(response);
      return [];
    }
    if (!response.ok) throw new Error(`SPOTIFY_SEARCH_${response.status}`);
    const items = ((await response.json()) as SearchResponse).tracks?.items ?? [];
    const found: Array<{ title: string; artist: string; album?: string; durationMs?: number; isrc?: string; artwork?: string }> = [];
    for (const track of items) {
      const artist = (track.artists ?? [])
        .map((entry) => entry.name ?? "")
        .filter(Boolean)
        .join(", ");
      if (track.name === undefined || artist.length === 0) continue;
      found.push({
        title: track.name,
        artist,
        ...(track.album?.name === undefined ? {} : { album: track.album.name }),
        ...(track.duration_ms === undefined ? {} : { durationMs: track.duration_ms }),
        ...(track.external_ids?.isrc === undefined ? {} : { isrc: track.external_ids.isrc.toUpperCase() }),
        ...(track.album?.images?.[0]?.url === undefined ? {} : { artwork: track.album.images[0].url }),
      });
    }
    return found;
  }

  /** The best match for the seed, or undefined when Spotify has nothing convincing. */
  async identify(seed: RecordingSeed): Promise<{ isrc?: string; durationMs?: number; album?: string } | undefined> {
    // Rate-limited: every further call is a 429 that can stretch the ban across the whole run.
    if (this.blockedForMs > 0) return undefined;
    // An ISRC names one recording, so when we already hold one there is nothing left to verify.
    // It is also the only way to reach a track the catalogue files under another script: Spotify
    // lists Ado's ギラギラ as "Gira Gira", and searching the Japanese title returns live cuts.
    if (seed.isrc !== undefined && seed.isrc.length > 0) {
      const exact = (await this.#search(`isrc:${seed.isrc}`))[0];
      if (exact !== undefined) return describe(exact, seed.isrc);
    }
    const items = await this.#search(`track:${seed.title} artist:${seed.artist}`);
    const wantedTitle = normalize(seed.title);
    const wantedArtist = normalize(seed.artist);
    for (const track of items) {
      if (track.name === undefined) continue;
      // Both title and artist have to agree: a wrong ISRC is worse than none, because it keys
      // the public row and every alignment published under it.
      if (normalize(track.name) !== wantedTitle) continue;
      const credited = (track.artists ?? []).map((artist) => normalize(artist.name ?? "")).filter((name) => name.length > 0);
      if (!credited.some((name) => name === wantedArtist || name.includes(wantedArtist) || wantedArtist.includes(name))) continue;
      return describe(track);
    }
    return undefined;
  }
}

function describe(track: SpotifyTrack, fallbackIsrc?: string): { isrc?: string; durationMs?: number; album?: string } {
  const isrc = typeof track.external_ids?.isrc === "string" && track.external_ids.isrc.length > 0 ? track.external_ids.isrc : fallbackIsrc;
  return {
    ...(isrc === undefined ? {} : { isrc: isrc.replaceAll("-", "").toUpperCase() }),
    ...(typeof track.duration_ms === "number" && track.duration_ms > 0 ? { durationMs: track.duration_ms } : {}),
    ...(typeof track.album?.name === "string" && track.album.name.length > 0 ? { album: track.album.name } : {}),
  };
}
