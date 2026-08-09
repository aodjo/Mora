import type { RecordingSeed } from "./types.js";

/**
 * LyricFind's public site search as a catalogue: ISRC and track length without credentials.
 *
 * It answers what Spotify answers — which recording is this, how long does it run — and it
 * answers in the song's own script: ギラギラ comes back as ギラギラ with its ISRC, where Spotify
 * files it under "Gira Gira" and only finds it when the ISRC is already known. It also has no
 * client quota to exhaust, which is what benched Spotify for seventeen hours mid-run.
 *
 * Durations are printed as m:ss, so a length from here is at most half a second off — well
 * inside the two-second drift gate it feeds.
 */

const SEARCH_URL = "https://lyrics.lyricfind.com/api/v1/search";
// The site rejects clients that do not look like one.
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:153.0) Gecko/20100101 Firefox/153.0";

interface FoundTrack {
  title?: string;
  titleSimple?: string;
  duration?: string;
  isrcs?: string[];
  instrumental?: boolean;
  artists?: Array<{ name?: string; nameRomanized?: string; is_primary?: boolean }>;
  artist?: { name?: string; nameRomanized?: string };
}

export class LyricFindCatalogue {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  /** The best match for the seed, or undefined when LyricFind does not carry it. */
  async identify(seed: RecordingSeed): Promise<{ isrc?: string; durationMs?: number } | undefined> {
    const query = new URLSearchParams({
      reqtype: "default",
      territory: "KR",
      searchtype: "track",
      all: `${seed.artist} ${seed.title}`,
      alltracks: "no",
      limit: "10",
      output: "json",
    });
    const response = await this.fetcher(`${SEARCH_URL}?${query.toString()}`, { headers: { "user-agent": USER_AGENT } });
    if (!response.ok) throw new Error(`LYRICFIND_SEARCH_${response.status}`);
    const tracks = ((await response.json()) as { tracks?: FoundTrack[] }).tracks ?? [];
    const wantedTitle = normalize(seed.title);
    const wantedArtist = normalize(seed.artist);
    for (const track of tracks) {
      const title = normalize(track.titleSimple ?? track.title ?? "");
      if (title !== wantedTitle) continue;
      if (!names(track).some((name) => name === wantedArtist)) continue;
      const durationMs = parseDuration(track.duration);
      const isrc = track.isrcs?.[0];
      if (isrc === undefined && durationMs === undefined) continue;
      return { ...(isrc === undefined ? {} : { isrc }), ...(durationMs === undefined ? {} : { durationMs }) };
    }
    return undefined;
  }
}

/** Every name the track answers to — 방탄소년단 and BTS are the same row here. */
function names(track: FoundTrack): string[] {
  const credited = [...(track.artists ?? []), ...(track.artist === undefined ? [] : [track.artist])];
  return credited
    .flatMap((artist) => [artist.name, artist.nameRomanized].filter((name): name is string => name !== undefined))
    .map(normalize);
}

function parseDuration(printed: string | undefined): number | undefined {
  const match = printed === undefined ? null : /^(\d+):(\d{2})$/u.exec(printed);
  if (match === null) return undefined;
  return (Number(match[1]) * 60 + Number(match[2])) * 1000;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}
