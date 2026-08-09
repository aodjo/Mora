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
    const byArtist = tracks.filter((track) => names(track).some((name) => name === wantedArtist));
    const answer = (track: FoundTrack): { isrc?: string; durationMs?: number } | undefined => {
      const durationMs = parseDuration(track.duration);
      const isrc = track.isrcs?.[0];
      if (isrc === undefined && durationMs === undefined) return undefined;
      return { ...(isrc === undefined ? {} : { isrc }), ...(durationMs === undefined ? {} : { durationMs }) };
    };
    for (const track of byArtist) {
      if (normalize(track.titleSimple ?? track.title ?? "") !== wantedTitle) continue;
      const found = answer(track);
      if (found !== undefined) return found;
    }
    // The catalogue writes the translation into the title too — "좋은 날" is filed as
    // "좋은 날 Good Day". Taking a prefix is only safe while it points at one song: a short
    // title prefixes many, and a version marker in the tail means a different recording.
    const alternates = byArtist.filter((track) => translatedFrom(wantedTitle, track.titleSimple ?? track.title ?? ""));
    const distinct = new Set(alternates.map((track) => normalize(track.titleSimple ?? track.title ?? "")));
    if (distinct.size !== 1) return undefined;
    for (const track of alternates) {
      const found = answer(track);
      if (found !== undefined) return found;
    }
    return undefined;
  }
}

/**
 * Every name the track answers to.
 *
 * Charts credit an artist one way and catalogues another. LyricFind carries the romanisation
 * in its own field — 방탄소년단 and BTS are the same row — but it also writes the second name
 * into the first, as "로제 (ROSÉ)" or "아이유 (IU)", and a chart that says only "로제" would
 * otherwise miss its own song. So a bracketed alias counts as a name of its own, alongside
 * the whole string, which keeps the match exact rather than letting one name contain another.
 */
function names(track: FoundTrack): string[] {
  const credited = [...(track.artists ?? []), ...(track.artist === undefined ? [] : [track.artist])];
  const written = credited.flatMap((artist) =>
    [artist.name, artist.nameRomanized].filter((name): name is string => name !== undefined && name.length > 0),
  );
  return written.flatMap((name) => [name, ...aliases(name)]).map(normalize);
}

/** "로제 (ROSÉ)" also answers to 로제 and to ROSÉ. */
function aliases(name: string): string[] {
  const bracketed = [...name.matchAll(/[（(]([^）)]+)[）)]/gu)].map((match) => match[1] ?? "");
  const outside = name.replace(/[（(][^）)]*[）)]/gu, " ");
  return [...bracketed, outside].map((part) => part.trim()).filter((part) => part.length > 0);
}

/** A recording of a different kind, whatever else the title says. */
const OTHER_RECORDING = /\b(?:inst|instrumental|remix|live|acoustic|ver|version|edit|mix|remaster|karaoke|cover|feat|with)\b/iu;

/** True when the catalogue title is ours with its translation appended, and nothing else. */
function translatedFrom(wanted: string, printed: string): boolean {
  const candidate = normalize(printed);
  if (!candidate.startsWith(wanted) || candidate === wanted) return false;
  // A bracket is how this catalogue marks a version, never how it marks a translation.
  if (/[（(\[［]/u.test(printed)) return false;
  return !OTHER_RECORDING.test(printed.slice(matchedLength(printed, wanted)));
}

/** How much of the printed title the wanted title consumed, in the printed string's own units. */
function matchedLength(printed: string, wanted: string): number {
  for (let cut = 1; cut <= printed.length; cut++) if (normalize(printed.slice(0, cut)) === wanted) return cut;
  return 0;
}

function parseDuration(printed: string | undefined): number | undefined {
  const match = printed === undefined ? null : /^(\d+):(\d{2})$/u.exec(printed);
  if (match === null) return undefined;
  return (Number(match[1]) * 60 + Number(match[2])) * 1000;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}
