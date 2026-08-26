import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { RecordingSeed, YoutubeCandidate } from "./types.js";

const run = promisify(execFile);
/** yt-dlp 의 평면 검색 결과 한 줄. 테스트가 검색을 대신할 수 있도록 내보낸다. */
export interface YtEntry {
  id?: string;
  title?: string;
  track?: string;
  artist?: string;
  album?: string;
  duration?: number;
  uploader?: string;
  channel?: string;
  webpage_url?: string;
  categories?: string[];
  live_status?: string;
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/(?:official\s*)?(?:music\s*)?video|audio|lyrics?|topic/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Uploads that carry the right title over audio that is not the recording: someone else singing
 * it, a backing track, or a master that has been re-timed. "cover" alone missed "covered by",
 * and the ASCII words missed every Japanese and Korean upload — the top hit for Ado's ギラギラ
 * was a cover scoring 0.89.
 *
 * The spelled-out "instrumental" is the western habit. Korean and Japanese labels post the
 * backing track as "(Inst.)", and they post it from the artist's own channel, so it clears the
 * official-channel check and outranks the real upload. 10CM's "To Reach You (Inst.)" was
 * selected that way, and a track with no voice on it cannot be aligned at all — every word came
 * out guessed. Abbreviations are the whole exposure here, so they are all listed.
 */
const NOT_THE_RECORDING =
  /\b(?:cover(?:ed|s)?|karaoke|instrumental|inst|off\s*vocal|backing\s*track|remix|mashup|nightcore|reverb|acoustic|piano|8d\s*audio|vinyl|rip)\b|\b(?:sped|speed)\s*up\b|\bslowed\b|\(\s*mr\s*\)|\bmr\s*(?:ver\.?|version|제거|버전)|[+-]\s*\d+(?:\.\d+)?\s*st\b|pitch\s*shift|커버|노래방|반주|인스트|가라오케|불러봄|歌ってみた|カラオケ|弾いてみた|演奏してみた/iu;

/**
 * A rendition of the song that is not the recording the seed names: another language's cut runs
 * to a different vocal, and a dance practice is a room mic over a video. Both share the title,
 * and aespa's "Whiplash (English Version)" auto-selected over the Korean original because of it.
 */
const OTHER_RENDITION =
  /\b(?:english|korean|japanese|chinese|mandarin|spanish|band|festival|orchestra)\s*(?:version|ver\.?)|\bdance\s*practice\b|\bchoreograph|\bperformance\s*(?:video|clip)\b|안무|퍼포먼스/iu;

/** A stage recording of the song, which is a different performance from the released one. */
const A_PERFORMANCE = /\b(?:live|라이브)\b|歌唱|공연/iu;

/**
 * An hour of the song on repeat, a medley, or a stretched edit. The title is the song's, the
 * audio is not the released master, and the length gives it away only when it is a full hour —
 * a three-song medley or an "extended mix" sits comfortably inside the duration bounds.
 *
 * The hour check used to live inline as /\d+\s*(?:시간|hours?|hr)\b/ and never once fired on a
 * Korean upload: \b after 간 asks for an ASCII word character that a Hangul syllable can never
 * be, so "아이유 밤편지 1시간" tested false. The digit is what carries the meaning, so the
 * boundary is spelled as "not another digit" instead.
 *
 * Only phrases that name the edit are listed. "extended" steps around "Extended Play", which is
 * an EP and says nothing about the audio; 슬로우드 is the Korean spelling of slowed, whose
 * English form NOT_THE_RECORDING already carries; 반복재생·연속듣기 are what a Korean loop
 * upload calls itself when it does not count hours; 메들리/メドレー are medley in the scripts the
 * uploads are actually written in. Bare 루프 is left out: it lives inside 루프탑 and other
 * ordinary words, and a Korean loop upload says 시간 or 반복 anyway.
 */
const A_LOOP_OR_COMPILATION =
  /\d+\s*(?:시간|時間)(?!\d)|\d+\s*(?:hours?|hrs?)\b|\bloop(?:ed|ing)?\b|\bextended\b(?!\s*play\b)|반복\s*재생|연속\s*(?:재생|듣기)|\bmedley\b|메들리|メドレー|슬로우드/iu;

/**
 * Whether the upload is something other than the released recording. Only what the uploader
 * wrote around the song title counts, so that Oasis' "Live Forever" and Springsteen's "Cover
 * Me" are not disqualified by their own names — and, now that the loop phrases are judged the
 * same way, neither is a song of its own called "Loop" or one whose title counts hours.
 */
export function isDifferentRecording(videoTitle: string, songTitle: string): boolean {
  const escaped = songTitle.trim().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const added = escaped.length === 0 ? videoTitle : videoTitle.replace(new RegExp(escaped, "giu"), " ");
  return NOT_THE_RECORDING.test(added) || OTHER_RENDITION.test(added) || A_PERFORMANCE.test(added) || A_LOOP_OR_COMPILATION.test(added);
}

/** Channel-name words that say nothing about who owns the channel. */
const CHANNEL_NOISE = new Set(["official", "vevo", "topic", "music", "records", "record", "label", "channel", "tv", "entertainment"]);

function tokens(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/**
 * The word "official" in a channel name means nothing: NORISTRY Official uploads covers and
 * JXS_BP Official reuploads other labels' masters, while the channels that actually hold the
 * recording are named Red Velvet, aespa and Oasis. What counts is whether the channel is the
 * artist's own, or the "<artist> - Topic" channel the label feeds automatically.
 */
export function isArtistChannel(channel: string, artist: string): boolean {
  const owner = tokens(channel);
  if (owner.length === 0) return false;
  // 이름을 두 문자로 함께 적는 일이 흔하다 — 카탈로그는 "혁오 (HYUKOH)" 라 적고 채널은
  // "HYUKOH" 하나만 쓴다. 모든 낱말이 채널에 있기를 요구하면 그 채널은 제 아티스트의
  // 것이 아니라고 판정되고, 위잉위잉의 공식 오디오가 비공식으로 밀려났다. 그러니 이름은
  // 부르는 방식마다 따로 세고, 그중 하나가 온전히 불리면 그 채널은 그 아티스트의 것이다.
  const spellings = nameSpellings(artist);
  if (spellings.length === 0) return false;
  const named = spellings.filter((spelling) => spelling.every((word) => owner.includes(word)));
  if (named.length === 0) return false;
  // What "official" buys is room for the rest of the name, because IU's channel is
  // "이지금 [IU Official]" — a reuploader calling itself JXS_BP Official still fails,
  // having never named the artist at all.
  const anyWord = new Set(spellings.flat());
  return owner.includes("official") || owner.every((word) => anyWord.has(word) || CHANNEL_NOISE.has(word));
}

/**
 * 한 이름을 부르는 방식들.
 *
 * "혁오 (HYUKOH)" 는 혁오이기도 하고 HYUKOH 이기도 하다. 괄호 안팎을 따로 세고 전체도 함께
 * 두어, 어느 쪽으로 불렸든 알아보되 서로 다른 이름이 섞이지는 않게 한다.
 */
function nameSpellings(artist: string): string[][] {
  const whole = tokens(artist);
  if (whole.length === 0) return [];
  const inside = [...artist.matchAll(/[（([［]([^）)\]］]+)[）)\]］]/gu)].map((match) => tokens(match[1] ?? ""));
  const outside = tokens(artist.replace(/[（([［][^）)\]］]*[）)\]］]/gu, " "));
  return [whole, outside, ...inside].filter((parts) => parts.length > 0);
}

/**
 * How far an upload of the released master may run from the length we publish the recording at.
 *
 * Measured over 70 songs that aligned cleanly: the gap between the catalogue length carried on
 * the recording and the audio that was actually timed had a median of 0.0s and a maximum of
 * 2.4s, and not one of them passed 5s. YouTube answers in whole seconds, so rounding alone
 * spends half of the first second. The old 2s cut through the top of that measured spread; 3s
 * clears it while staying far below the 5s nothing ever reached.
 */
export const RECORDING_DRIFT_TOLERANCE_MS = 3_000;

export interface YoutubeSearchResult {
  video_id: string;
  title: string;
  channel: string;
  duration_ms: number;
  is_live: boolean;
}

/**
 * A plain search, for a person to look through.
 *
 * Unlike the collection search this filters nothing and ranks nothing: the reviewer is the
 * judge, and hiding a result they were looking for is worse than showing one they were not.
 */
export async function searchYoutube(query: string, limit = 20): Promise<YoutubeSearchResult[]> {
  const wanted = Math.max(1, Math.min(40, Math.trunc(limit)));
  const { stdout } = await run(
    youtubeDlCommand(),
    ["--dump-single-json", "--flat-playlist", "--no-warnings", `ytsearch${wanted}:${query}`],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as { entries?: YtEntry[] };
  return (parsed.entries ?? []).flatMap((entry): YoutubeSearchResult[] =>
    entry.id === undefined || entry.title === undefined
      ? []
      : [
          {
            video_id: entry.id,
            title: entry.title,
            channel: entry.channel ?? entry.uploader ?? "",
            duration_ms: Math.round((entry.duration ?? 0) * 1000),
            is_live: entry.live_status === "is_live",
          },
        ],
  );
}

/**
 * The uploads worth considering for this song.
 *
 * Asking for "audio" puts the official audio above the music video for a song people search
 * for — "aespa Whiplash audio" opens with Official Audio where the plain query opens with the
 * MV. For a song nobody searches for it does the opposite of helping: "uruma 하치와레girl
 * feat.pshine audio" returns nothing at all, while the artist's own upload sits at the top of
 * the query without it. So the narrow question is asked first and the plain one only when the
 * narrow one leaves us with nothing, which is exactly when the answer was "음원 없음".
 */
export async function searchYoutubeMusic(
  seed: RecordingSeed,
  ask: (query: string) => Promise<YtEntry[]> = askYoutube,
): Promise<YoutubeCandidate[]> {
  // Deliberately without the album: it pulls the search towards the record rather than the
  // track, and "BTS Come Over Proof audio" returns the album's other songs and a live stream
  // where "BTS Come Over audio" returns the official audio first.
  const found = await candidatesFor(seed, await ask(`${seed.artist} ${seed.title} audio`));
  return found.length > 0 ? found : candidatesFor(seed, await ask(`${seed.artist} ${seed.title}`));
}

async function askYoutube(query: string): Promise<YtEntry[]> {
  const { stdout } = await run(youtubeDlCommand(), ["--dump-single-json", "--flat-playlist", "--no-warnings", `ytsearch25:${query}`], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return (JSON.parse(stdout) as { entries?: YtEntry[] }).entries ?? [];
}

function candidatesFor(seed: RecordingSeed, entries: YtEntry[]): YoutubeCandidate[] {
  return entries
    .flatMap((entry): YoutubeCandidate[] => {
      if (!entry.id || !entry.title || entry.live_status === "is_live") return [];
      const title = entry.track ?? entry.title;
      const artist = entry.artist ?? entry.uploader ?? entry.channel ?? "";
      // Covers, backing tracks, other renditions, stage cuts, and loops or medleys.
      if (isDifferentRecording(entry.title, seed.title)) return [];
      const durationMs = Math.round((entry.duration ?? 0) * 1000);
      // Snippets, edits and Shorts carry the right title over a fragment of the song, and a
      // compilation carries it over far too much. Judge against the length we are looking for.
      if (durationMs > 0 && durationMs < Math.max(45_000, (seed.duration_ms ?? 0) * 0.5)) return [];
      if (durationMs > 0 && seed.duration_ms !== undefined && durationMs > seed.duration_ms * 2.5) return [];
      // Demoted rather than dropped: a music video's audio is second choice, but for some songs
      // it is the only upload there is, and review can still offer it.
      const isVideo = /\b(?:official\s*)?(?:music\s*)?video\b|\bm\.?v\.?\b/iu.test(entry.title);
      const titleScore = normalize(title) === normalize(seed.title) ? 1 : normalize(title).includes(normalize(seed.title)) ? 0.8 : 0;
      // Search results come back flat, without the artist field, so the fallback was the channel
      // name — and a label or reupload channel is never named after the artist. The artist is in
      // the video title instead, which is where this now looks.
      // 붙여 놓고 이어진 부분문자열을 찾으면 순서가 바뀐 이름을 놓친다. 시드는 "혁오 (HYUKOH)"
      // 라 적고 영상은 "HYUKOH(혁오)" 라 적는데, 앞엣것은 "혁오hyukoh" 뒤엣것은 "hyukoh혁오"가
      // 되어 서로를 품지 못한다 — 위잉위잉이 아티스트 0점을 받은 까닭이다. 낱말로 보면 된다.
      const credited = new Set([...tokens(artist), ...tokens(entry.title)]);
      const artistScore = nameSpellings(seed.artist).some((spelling) => spelling.every((word) => credited.has(word))) ? 1 : 0;
      // An upload of the same recording drifts a second or two from the catalogue length —
      // silence padding, a trimmed fade. Past the tolerance it falls away quickly rather than
      // over twelve seconds: a copy that runs ten seconds long is a different edit, not a fade.
      // Neutral at 0.5 when there is no length to compare against, so an unknown neither
      // vouches for the upload nor argues against it.
      const drift = seed.duration_ms === undefined || durationMs === 0 ? undefined : Math.abs(seed.duration_ms - durationMs);
      const durationScore =
        drift === undefined
          ? 0.5
          : drift <= RECORDING_DRIFT_TOLERANCE_MS
            ? 1
            : Math.max(0, 1 - (drift - RECORDING_DRIFT_TOLERANCE_MS) / 9_000);
      const channel = entry.channel ?? entry.uploader ?? "";
      const official = isArtistChannel(channel, seed.artist);
      const catalogueDrift =
        seed.catalogue_duration_ms === undefined || durationMs === 0 ? undefined : Math.abs(seed.catalogue_duration_ms - durationMs);
      /**
       * Length first, then who the upload says it is, and ownership only as a nudge.
       *
       * The weights used to read 0.45 title / 0.35 artist / 0.15 length, and the title is the
       * one signal a flat search cannot deliver: yt-dlp returns the whole video title, so
       * titleScore is 0.8 rather than 1 for the large majority of real candidates and no
       * unofficial upload could reach 0.85 however exactly it matched. Length is also the only
       * thing here that speaks to the question we actually care about — is this that recording
       * — because a cover, a live cut and a remaster all carry a perfect title and artist.
       *
       * Ownership is worth 0.05: enough to put the artist's own copy above an identical
       * reupload, never enough to stand in for a length that disagrees.
       */
      const score = durationScore * 0.4 + titleScore * 0.35 + artistScore * 0.2 + (official ? 0.05 : 0) - (isVideo ? 0.1 : 0);
      // Neither the song nor the artist is named: the search answered with something else
      // entirely, and no length agreement can make it this song.
      if (titleScore === 0 && artistScore === 0) return [];
      // Only a floor against noise. The shortlist is what a person gets to choose from, and a
      // candidate dropped here is not demoted but gone — with nothing left, the song is filed
      // as "음원 없음" and remembered, so it never comes back. Length disagreement belongs to
      // the ranking and to auto-selection, not to this gate: some songs have only their music
      // video, and review can still offer it.
      if (score < 0.35) return [];
      return [
        {
          url: `https://music.youtube.com/watch?v=${entry.id}`,
          video_id: entry.id,
          title,
          artist,
          album: entry.album,
          duration_ms: durationMs,
          official,
          source_type: official ? (/-\s*topic$/iu.test(channel.trim()) ? "topic" : "song") : "unofficial",
          score,
          ...(catalogueDrift === undefined ? {} : { catalogue_drift_ms: catalogueDrift }),
        },
      ];
    })
    .sort(rankSource)
    .slice(0, 3);
}

/**
 * Confirmed by the catalogue length first, then by the score, and only then by who posted it.
 *
 * Ownership used to sort above the score outright, which put an official channel's mediocre
 * match ahead of an unofficial exact one — the artist's 4:05 music video ahead of the only copy
 * of the 2:39 master. It is the tie-break worth having, not a rank of its own: a fan lyrics
 * video and the artist's own upload of the same audio match to the second, and the artist's is
 * the one that will still be there next month.
 */
function rankSource(a: YoutubeCandidate, b: YoutubeCandidate): number {
  const verified = (item: YoutubeCandidate): number =>
    item.catalogue_drift_ms !== undefined && item.catalogue_drift_ms <= RECORDING_DRIFT_TOLERANCE_MS ? 1 : 0;
  return verified(b) - verified(a) || b.score - a.score || Number(b.official) - Number(a.official);
}

function youtubeDlCommand(): string {
  if (process.env.YTDLP_BIN !== undefined && process.env.YTDLP_BIN.length > 0) return process.env.YTDLP_BIN;
  const candidates =
    process.platform === "win32"
      ? [resolve(process.cwd(), "Generator/.venv/Scripts/yt-dlp.exe")]
      : [resolve(process.cwd(), "Generator/.venv/bin/yt-dlp")];
  return candidates.find((candidate) => existsSync(candidate)) ?? "yt-dlp";
}
