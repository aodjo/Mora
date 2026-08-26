import type { RecordingSeed } from "./types.js";

/**
 * LyricFind's public site search as a catalogue: ISRC and track length without credentials.
 *
 * It answers what a catalogue must — which recording is this, how long does it run — and it
 * answers in the song's own script: ギラギラ comes back as ギラギラ with its ISRC. It has no
 * client quota to exhaust, which is what retired Spotify from this chain: that client spent
 * more of a run rate-limited than answering.
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
  titleRomanized?: string;
  duration?: string;
  isrcs?: string[];
  instrumental?: boolean;
  language?: string;
  artists?: Array<{ name?: string; nameRomanized?: string; is_primary?: boolean }>;
  artist?: { name?: string; nameRomanized?: string };
}

/**
 * What the catalogue knows about a track beyond its identifier.
 *
 * 차트는 곡을 제 나라 말로 옮겨 적어 준다. Apple 의 목록에서 이무진의 「청춘만화」는 "Lee
 * Mujin / Coming Of Age Story" 로 오는데, 가사를 가진 한국 서비스들은 그 곡을 「청춘만화」로만
 * 걸어 두었으므로 번역된 제목으로는 한 곳도 찾지 못한다 — 실측한 99 건의 수집 실패 가운데
 * 열다섯이 그것이었다. 이 카탈로그는 "청춘만화 Coming Of Age Story" 와 "이무진" 을 한 줄에
 * 들고 있으니, 물어보면 원래 이름을 돌려준다.
 */
export interface CatalogueEntry {
  isrc?: string;
  durationMs?: number;
  album?: string;
  /** 카탈로그가 적어 둔 제목 — 번역이 붙어 있으면 그것까지 그대로. */
  title?: string;
  /** 그 제목에서 번역을 떼어낸 원래 제목. */
  nativeTitle?: string;
  /** 카탈로그가 적어 둔 아티스트 이름, 원어 쪽. */
  nativeArtist?: string;
  /** 카탈로그가 밝힌 언어. 가사 글자를 세어 짐작하는 것보다 낫다. */
  language?: string;
  /** 노래가 없는 트랙. 제목에 (Inst.) 가 없어도 여기서는 드러난다. */
  instrumental?: boolean;
}

export class LyricFindCatalogue {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  /** The best match for the seed, or undefined when LyricFind does not carry it. */
  async identify(seed: RecordingSeed): Promise<CatalogueEntry | undefined> {
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
    const answer = (track: FoundTrack, nativeFromMatch?: string): CatalogueEntry | undefined => {
      const durationMs = parseDuration(track.duration);
      const isrc = track.isrcs?.[0];
      // 같은 곡이 두 줄로 오고 한 줄은 길이도 ISRC 도 비어 있는 일이 흔하다. 이름과 언어만
      // 든 줄은 곡을 가리키지 못하므로 다음 줄로 넘어간다 — 늘어난 필드가 그 판단을 흐리면
      // 정보가 있는 줄에 영영 닿지 못한다.
      if (isrc === undefined && durationMs === undefined) return undefined;
      const printed = track.titleSimple ?? track.title;
      // 이름은 원어 쪽을 고른다. name 이 "이무진", nameRomanized 가 "Lee Mujin" 이고,
      // 가사를 들고 있는 서비스들이 거는 쪽은 앞엣것이다.
      const credited = [...(track.artists ?? []), ...(track.artist === undefined ? [] : [track.artist])];
      const nativeArtist = credited.find((one) => (one.name ?? "").length > 0)?.name;
      const found: CatalogueEntry = {
        ...(isrc === undefined ? {} : { isrc }),
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(printed === undefined ? {} : { title: printed }),
        // 원어 제목은 두 길로 온다. 차트가 영어로 옮겨 적었으면 카탈로그의 titleRomanized 가
        // 그 영어와 같으므로 앞부분이 원어이고, 차트가 이미 원어를 줬으면 맞춰진 그 앞부분이
        // 곧 원어다 — 「좋은 날 Good Day」에서 우리가 물은 "좋은 날" 이 그것이다.
        ...(nativeFromMatch !== undefined
          ? { nativeTitle: nativeFromMatch }
          : printed === undefined
            ? {}
            : nativeOf(printed, track.titleRomanized)),
        ...(nativeArtist === undefined ? {} : { nativeArtist }),
        ...(track.language === undefined ? {} : { language: track.language }),
        ...(track.instrumental === undefined ? {} : { instrumental: track.instrumental }),
      };
      return found;
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
    if (distinct.size === 1) {
      for (const track of alternates) {
        const found = answer(track, seed.title);
        if (found !== undefined) return found;
      }
    }
    // 그리고 그 반대. 차트가 제목을 옮겨 적어 주면 우리는 영어로 묻는데, 카탈로그는 원어를
    // 앞에 두고 그 영어를 뒤에 붙여 둔다 — "Coming Of Age Story" 로 물으면 "청춘만화 Coming
    // Of Age Story" 가 나온다. 가사를 걸어 둔 서비스들이 아는 이름은 앞의 「청춘만화」이므로,
    // 여기서 그것을 건져야 그 열다섯 곡이 살아난다.
    const translated = byArtist.filter((track) => translationOf(wantedTitle, track.titleSimple ?? track.title ?? ""));
    const oneSong = new Set(translated.map((track) => normalize(track.titleSimple ?? track.title ?? "")));
    if (oneSong.size !== 1) return undefined;
    for (const track of translated) {
      const printed = track.titleSimple ?? track.title ?? "";
      const found = answer(track, nativeHead(printed, wantedTitle));
      if (found !== undefined) return found;
    }
    return undefined;
  }
}

/**
 * 제목에서 번역을 떼어낸다.
 *
 * 이 카탈로그는 번역을 제목 뒤에 이어 붙여 "청춘만화 Coming Of Age Story" 로 적는다. 뒤에
 * 붙은 것이 titleRomanized 와 같으면 그것이 번역이고, 앞의 것이 원래 제목이다. 그 둘이 다르면
 * — 원래부터 그런 제목이거나 판본 표시일 수 있으므로 — 손대지 않는다.
 */
function nativeOf(printed: string, romanized: string | undefined): { nativeTitle: string } | Record<string, never> {
  if (romanized === undefined || romanized.length === 0) return {};
  const tail = printed.slice(-romanized.length);
  if (normalize(tail) !== normalize(romanized)) return {};
  const head = printed.slice(0, printed.length - romanized.length).trim();
  return head.length === 0 || normalize(head) === normalize(romanized) ? {} : { nativeTitle: head };
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

/**
 * True when the catalogue title is the original with our title appended as its translation.
 *
 * The mirror of translatedFrom: there we asked in the song's own language and the catalogue had
 * added a translation; here the chart translated for us and the catalogue kept the original in
 * front. A bracket still marks a version rather than a translation, and a version marker in the
 * head means a different recording — "청춘만화 (Live) Coming Of Age Story" is not the song.
 */
function translationOf(wanted: string, printed: string): boolean {
  const candidate = normalize(printed);
  if (!candidate.endsWith(wanted) || candidate === wanted) return false;
  if (/[（(\[［]/u.test(printed)) return false;
  const head = nativeHead(printed, wanted);
  // 앞부분이 남아 있어야 원어 제목이고, 공백으로 갈려 있어야 낱말이 잘리지 않는다.
  return head.length > 0 && normalize(printed).slice(head.length).trimStart().length === wanted.length;
}

/** The part of the printed title that comes before our translated one. */
function nativeHead(printed: string, wanted: string): string {
  for (let cut = printed.length; cut >= 0; cut--) if (normalize(printed.slice(cut)) === wanted) return printed.slice(0, cut).trim();
  return "";
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
