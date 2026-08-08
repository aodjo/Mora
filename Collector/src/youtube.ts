import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { RecordingSeed, YoutubeCandidate } from "./types.js";

const run = promisify(execFile);
interface YtEntry {
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
 */
const NOT_THE_RECORDING =
  /\b(?:cover(?:ed|s)?|karaoke|instrumental|remix|mashup|nightcore|reverb|acoustic|piano|8d\s*audio|vinyl|rip)\b|\b(?:sped|speed)\s*up\b|\bslowed\b|[+-]\s*\d+(?:\.\d+)?\s*st\b|pitch\s*shift|커버|노래방|반주|불러봄|歌ってみた|カラオケ|弾いてみた|演奏してみた/iu;

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
 * Whether the upload is something other than the released recording. Only what the uploader
 * wrote around the song title counts, so that Oasis' "Live Forever" and Springsteen's "Cover
 * Me" are not disqualified by their own names.
 */
export function isDifferentRecording(videoTitle: string, songTitle: string): boolean {
  const escaped = songTitle.trim().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const added = escaped.length === 0 ? videoTitle : videoTitle.replace(new RegExp(escaped, "giu"), " ");
  return NOT_THE_RECORDING.test(added) || OTHER_RENDITION.test(added) || A_PERFORMANCE.test(added);
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
  const wanted = tokens(artist);
  const owner = tokens(channel);
  if (wanted.length === 0 || owner.length === 0) return false;
  // The artist has to be named either way. What "official" buys is room for the rest of the
  // name, because IU's channel is "이지금 [IU Official]" — a reuploader calling itself
  // JXS_BP Official still fails, having never named the artist at all.
  if (!wanted.every((word) => owner.includes(word))) return false;
  return owner.includes("official") || owner.every((word) => wanted.includes(word) || CHANNEL_NOISE.has(word));
}

export async function searchYoutubeMusic(seed: RecordingSeed): Promise<YoutubeCandidate[]> {
  // Deliberately without the album: it pulls the search towards the record rather than the
  // track, and "BTS Come Over Proof audio" returns the album's other songs and a live stream
  // where "BTS Come Over audio" returns the official audio first.
  const query = `${seed.artist} ${seed.title} audio`;
  const { stdout } = await run(youtubeDlCommand(), ["--dump-single-json", "--flat-playlist", "--no-warnings", `ytsearch25:${query}`], {
    maxBuffer: 10 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as { entries?: YtEntry[] };
  return (parsed.entries ?? [])
    .flatMap((entry): YoutubeCandidate[] => {
      if (!entry.id || !entry.title || entry.live_status === "is_live") return [];
      const title = entry.track ?? entry.title;
      const artist = entry.artist ?? entry.uploader ?? entry.channel ?? "";
      if (isDifferentRecording(entry.title, seed.title)) return [];
      // A loop or compilation shares the title but not the recording.
      if (/\d+\s*(?:시간|hours?|hr)\b/iu.test(entry.title)) return [];
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
      const credited = normalize(`${artist} ${entry.title}`);
      const wanted = normalize(seed.artist);
      const artistScore =
        wanted.length > 0 && (credited.includes(wanted) || (artist.length > 0 && wanted.includes(normalize(artist)))) ? 1 : 0;
      // An upload of the same recording drifts a second or two from the catalogue length —
      // silence padding, a trimmed fade. Scoring that linearly from zero made auto-selection
      // demand a match inside half a second, which almost nothing survives.
      const drift = seed.duration_ms === undefined ? undefined : Math.abs(seed.duration_ms - durationMs);
      const durationScore = drift === undefined || durationMs === 0 ? 0.5 : drift <= 2_000 ? 1 : Math.max(0, 1 - (drift - 2_000) / 12_000);
      const channel = entry.channel ?? entry.uploader ?? "";
      const official = isArtistChannel(channel, seed.artist);
      const score = titleScore * 0.45 + artistScore * 0.35 + durationScore * 0.15 + (official ? 0.05 : 0) - (isVideo ? 0.1 : 0);
      if (score < 0.55) return [];
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
        },
      ];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function youtubeDlCommand(): string {
  if (process.env.YTDLP_BIN !== undefined && process.env.YTDLP_BIN.length > 0) return process.env.YTDLP_BIN;
  const candidates =
    process.platform === "win32"
      ? [resolve(process.cwd(), "Generator/.venv/Scripts/yt-dlp.exe")]
      : [resolve(process.cwd(), "Generator/.venv/bin/yt-dlp")];
  return candidates.find((candidate) => existsSync(candidate)) ?? "yt-dlp";
}
