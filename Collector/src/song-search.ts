import type { RecordingSeed } from "./types.js";
import { LyricFindCatalogue } from "./lyricfind.js";
import { SpotifyClient } from "./spotify.js";

/**
 * Searching the music services by name, so a person can add a song the charts never carried.
 *
 * Discovery follows charts and albums, which is the right shape for filling a catalogue and the
 * wrong shape for "I want this one song". These are the same services the lyrics providers
 * already read, asked the other way round: give me candidates for these words.
 *
 * Every provider answers with the same shape so the console can merge them, and merging is the
 * point — one song found on four services should read as one row wearing four badges, not four
 * rows a person has to recognise as the same.
 */

export type SearchProvider = "melon" | "genie" | "vibe" | "spotify" | "lyricfind";

export interface SongHit {
  provider: SearchProvider;
  artist: string;
  title: string;
  album?: string;
  duration_ms?: number;
  isrc?: string;
  /** Cover art the console can show, when the service hands one over. */
  artwork?: string;
}

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:153.0) Gecko/20100101 Firefox/153.0";

export async function searchMelon(query: string, fetcher: typeof fetch = fetch): Promise<SongHit[]> {
  // The song tab draws its list from script; the total-search page ships the same rows as HTML.
  const url = `https://www.melon.com/search/total/index.htm?q=${encodeURIComponent(query)}`;
  const response = await fetcher(url, { headers: { "user-agent": BROWSER_UA } });
  if (!response.ok) throw new Error(`MELON_SEARCH_${response.status}`);
  const page = await response.text();
  const hits: SongHit[] = [];
  // Each row plays, then names its artist and album; the play anchor is the only one titled with
  // the song itself, so it anchors the split.
  for (const row of page.split('class="fc_gray"').slice(1)) {
    const title = /^[^>]*>([^<]+)<\/a>/u.exec(row)?.[1];
    const artist = /goArtistDetail\('\d+'\)[\s\S]{0,200}?class="fc_mgray">([^<]+)<\/a>/u.exec(row)?.[1];
    const album = /goAlbumDetail\('\d+'\);"[^>]*class="fc_mgray">([^<]+)<\/a>/u.exec(row)?.[1];
    if (title === undefined || artist === undefined) continue;
    const entry: SongHit = { provider: "melon", title: decode(title), artist: decode(artist) };
    if (album !== undefined) entry.album = decode(album);
    if (entry.title.length === 0 || entry.artist.length === 0) continue;
    if (hits.some((seen) => seen.title === entry.title && seen.artist === entry.artist)) continue;
    hits.push(entry);
    if (hits.length >= 20) break;
  }
  return hits;
}

export async function searchGenie(query: string, fetcher: typeof fetch = fetch): Promise<SongHit[]> {
  const response = await fetcher(`https://www.genie.co.kr/search/searchSong?query=${encodeURIComponent(query)}`, {
    headers: { "user-agent": BROWSER_UA },
  });
  if (!response.ok) throw new Error(`GENIE_SEARCH_${response.status}`);
  const page = await response.text();
  const hits: SongHit[] = [];
  // One <tr class="list"> per song; title, artist and album are the three ellipsis anchors in it.
  for (const row of page.split('<tr class="list"').slice(1)) {
    // The title anchor also holds TITLE/HOT badges; only the text after the last span is the song.
    const title = /class="title ellipsis"[^>]*>([\s\S]*?)<\/a>/u.exec(row)?.[1]?.replace(/[\s\S]*<\/span>/u, "");
    const artist = /class="artist ellipsis"[^>]*>([\s\S]*?)<\/a>/u.exec(row)?.[1];
    const album = /class="albumtitle ellipsis"[^>]*>([\s\S]*?)<\/a>/u.exec(row)?.[1];
    if (title === undefined || artist === undefined) continue;
    hits.push({
      provider: "genie",
      title: strip(title),
      artist: strip(artist),
      ...(album === undefined ? {} : { album: strip(album) }),
    });
    if (hits.length >= 20) break;
  }
  return hits.filter((hit) => hit.title.length > 0 && hit.artist.length > 0);
}

export async function searchVibe(query: string, fetcher: typeof fetch = fetch): Promise<SongHit[]> {
  const url = `https://apis.naver.com/vibeWeb/musicapiweb/v3/search/track?query=${encodeURIComponent(query)}&start=1&display=20`;
  const response = await fetcher(url, { headers: { "user-agent": BROWSER_UA, accept: "application/json" } });
  if (!response.ok) throw new Error(`VIBE_SEARCH_${response.status}`);
  const payload = (await response.json()) as {
    response?: {
      result?: {
        tracks?: Array<{
          trackTitle?: string;
          playTime?: number;
          artists?: Array<{ artistName?: string }>;
          album?: { albumTitle?: string; imageUrl?: string };
        }>;
      };
    };
  };
  const hits: SongHit[] = [];
  for (const track of payload.response?.result?.tracks ?? []) {
    const artist = (track.artists ?? [])
      .map((entry) => entry.artistName ?? "")
      .filter(Boolean)
      .join(", ");
    if (typeof track.trackTitle !== "string" || artist.length === 0) continue;
    hits.push({
      provider: "vibe",
      title: track.trackTitle,
      artist,
      ...(track.album?.albumTitle === undefined ? {} : { album: track.album.albumTitle }),
      ...(typeof track.playTime === "number" && track.playTime > 0 ? { duration_ms: track.playTime * 1000 } : {}),
      ...(track.album?.imageUrl === undefined ? {} : { artwork: track.album.imageUrl }),
    });
  }
  return hits;
}

export async function searchLyricFind(query: string, fetcher: typeof fetch = fetch): Promise<SongHit[]> {
  const url =
    `https://lyrics.lyricfind.com/api/v1/search?reqtype=default&territory=KR&searchtype=track` +
    `&all=${encodeURIComponent(query)}&alltracks=no&limit=20&output=json`;
  const response = await fetcher(url, { headers: { "user-agent": BROWSER_UA } });
  if (!response.ok) throw new Error(`LYRICFIND_SEARCH_${response.status}`);
  const payload = (await response.json()) as {
    tracks?: Array<{
      title?: string;
      titleSimple?: string;
      duration?: string;
      isrcs?: string[];
      instrumental?: boolean;
      artist?: { name?: string; nameRomanized?: string };
    }>;
  };
  const hits: SongHit[] = [];
  for (const track of payload.tracks ?? []) {
    const title = track.titleSimple ?? track.title;
    const artist = track.artist?.name;
    if (typeof title !== "string" || typeof artist !== "string") continue;
    const printed = /^(\d+):(\d{2})$/u.exec(track.duration ?? "");
    hits.push({
      provider: "lyricfind",
      title,
      artist,
      ...(track.isrcs?.[0] === undefined ? {} : { isrc: track.isrcs[0] }),
      ...(printed === null ? {} : { duration_ms: (Number(printed[1]) * 60 + Number(printed[2])) * 1000 }),
    });
  }
  return hits;
}

/** Spotify needs credentials, so it only appears when the collector has them. */
export async function searchSpotify(query: string, client: SpotifyClient): Promise<SongHit[]> {
  return (await client.searchTracks(query, 20)).map((track) => ({
    provider: "spotify" as const,
    title: track.title,
    artist: track.artist,
    ...(track.album === undefined ? {} : { album: track.album }),
    ...(track.durationMs === undefined ? {} : { duration_ms: track.durationMs }),
    ...(track.isrc === undefined ? {} : { isrc: track.isrc }),
    ...(track.artwork === undefined ? {} : { artwork: track.artwork }),
  }));
}

export interface SearchOptions {
  providers?: SearchProvider[];
  spotify?: SpotifyClient | undefined;
  fetcher?: typeof fetch;
}

export const ALL_PROVIDERS: SearchProvider[] = ["melon", "genie", "vibe", "spotify", "lyricfind"];

/**
 * Every asked-for provider at once, merged.
 *
 * A provider that is down or that carries nothing must not take the others with it, so each is
 * caught on its own and simply contributes nothing.
 */
export async function searchSong(query: string, options: SearchOptions = {}): Promise<MergedHit[]> {
  const fetcher = options.fetcher ?? fetch;
  const wanted = options.providers ?? ALL_PROVIDERS;
  const runs = wanted.map(async (provider): Promise<SongHit[]> => {
    switch (provider) {
      case "melon":
        return searchMelon(query, fetcher);
      case "genie":
        return searchGenie(query, fetcher);
      case "vibe":
        return searchVibe(query, fetcher);
      case "lyricfind":
        return searchLyricFind(query, fetcher);
      case "spotify":
        return options.spotify === undefined ? [] : searchSpotify(query, options.spotify);
    }
  });
  const found = (await Promise.all(runs.map((run) => run.catch(() => [] as SongHit[])))).flat();
  return merge(found);
}

export interface MergedHit {
  artist: string;
  title: string;
  album?: string;
  duration_ms?: number;
  isrc?: string;
  artwork?: string;
  /** Which services carry this song — the console shows one icon per name. */
  providers: SearchProvider[];
}

/**
 * One song per artist and title, however many services returned it.
 *
 * The services disagree about spelling — "아이유(IU)" and "IU" — so the key folds case, width and
 * anything that is not a letter or number, which is enough to bring the same song together
 * without merging "SWIM" into "SWIM (Inst.)".
 */
export function merge(hits: SongHit[]): MergedHit[] {
  const merged = new Map<string, MergedHit>();
  for (const hit of hits) {
    const key = `${fold(hit.artist)} ${fold(hit.title)}`;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, {
        artist: hit.artist,
        title: hit.title,
        ...(hit.album === undefined ? {} : { album: hit.album }),
        ...(hit.duration_ms === undefined ? {} : { duration_ms: hit.duration_ms }),
        ...(hit.isrc === undefined ? {} : { isrc: hit.isrc }),
        ...(hit.artwork === undefined ? {} : { artwork: hit.artwork }),
        providers: [hit.provider],
      });
      continue;
    }
    if (!existing.providers.includes(hit.provider)) existing.providers.push(hit.provider);
    // Take whatever the first service could not say.
    if (existing.album === undefined && hit.album !== undefined) existing.album = hit.album;
    if (existing.duration_ms === undefined && hit.duration_ms !== undefined) existing.duration_ms = hit.duration_ms;
    if (existing.isrc === undefined && hit.isrc !== undefined) existing.isrc = hit.isrc;
    if (existing.artwork === undefined && hit.artwork !== undefined) existing.artwork = hit.artwork;
  }
  // Carried by more services first — agreement is the best signal we have that it is the song.
  return [...merged.values()].sort((a, b) => b.providers.length - a.providers.length);
}

/** A hit the console kept, as the collector wants it. */
export function toSeed(hit: { artist: string; title: string; album?: string; duration_ms?: number; isrc?: string }): RecordingSeed {
  return {
    artist: hit.artist,
    title: hit.title,
    ...(hit.album === undefined ? {} : { album: hit.album }),
    ...(hit.duration_ms === undefined ? {} : { duration_ms: hit.duration_ms }),
    ...(hit.isrc === undefined ? {} : { isrc: hit.isrc }),
    // Chosen by a person, so it goes to the front of whatever else the run is doing.
    popularity: 1,
    freshness: 0,
    market: "KR",
  };
}

export { LyricFindCatalogue };

/**
 * The key two services must agree on. Bracketed asides are dropped — one service writes
 * "좋은 날", another "좋은 날 Good Day" — but only from the ends, so "SWIM (Inst.)" keeps the
 * mark that makes it a different recording.
 */
function fold(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function strip(value: string): string {
  return decode(value.replace(/<[^>]*>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim();
}

function decode(value: string): string {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#0?39;/gu, "'")
    .replace(/&nbsp;/gu, " ")
    .trim();
}
