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
  album?: { name?: string };
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

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

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
    if (!response.ok) throw new Error(`SPOTIFY_SEARCH_${response.status}`);
    return ((await response.json()) as SearchResponse).tracks?.items ?? [];
  }

  /** The best match for the seed, or undefined when Spotify has nothing convincing. */
  async identify(seed: RecordingSeed): Promise<{ isrc?: string; durationMs?: number; album?: string } | undefined> {
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
