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

export async function searchYoutubeMusic(seed: RecordingSeed): Promise<YoutubeCandidate[]> {
  const query = `${seed.artist} ${seed.title} ${seed.album ?? ""} audio`;
  const { stdout } = await run(youtubeDlCommand(), ["--dump-single-json", "--flat-playlist", "--no-warnings", `ytsearch10:${query}`], {
    maxBuffer: 10 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as { entries?: YtEntry[] };
  return (parsed.entries ?? [])
    .flatMap((entry): YoutubeCandidate[] => {
      if (!entry.id || !entry.title || entry.live_status === "is_live") return [];
      const title = entry.track ?? entry.title;
      const artist = entry.artist ?? entry.uploader ?? entry.channel ?? "";
      if (/\b(?:live|cover|karaoke|instrumental|sped\s*up|slowed|remix)\b/iu.test(title)) return [];
      // "Official MV" is how music videos are labelled here, and the video test alone missed it.
      if (/\b(?:official\s*)?(?:music\s*)?video\b|\bm\.?v\.?\b/iu.test(entry.title)) return [];
      const titleScore = normalize(title) === normalize(seed.title) ? 1 : normalize(title).includes(normalize(seed.title)) ? 0.8 : 0;
      // Search results come back flat, without the artist field, so the fallback was the channel
      // name — and a label or reupload channel is never named after the artist. The artist is in
      // the video title instead, which is where this now looks.
      const credited = normalize(`${artist} ${entry.title}`);
      const wanted = normalize(seed.artist);
      const artistScore =
        wanted.length > 0 && (credited.includes(wanted) || (artist.length > 0 && wanted.includes(normalize(artist)))) ? 1 : 0;
      const durationMs = Math.round((entry.duration ?? 0) * 1000);
      // An upload of the same recording drifts a second or two from the catalogue length —
      // silence padding, a trimmed fade. Scoring that linearly from zero made auto-selection
      // demand a match inside half a second, which almost nothing survives.
      const drift = seed.duration_ms === undefined ? undefined : Math.abs(seed.duration_ms - durationMs);
      const durationScore = drift === undefined || durationMs === 0 ? 0.5 : drift <= 2_000 ? 1 : Math.max(0, 1 - (drift - 2_000) / 12_000);
      const official = /topic|official/iu.test(`${entry.uploader ?? ""} ${entry.channel ?? ""}`);
      const score = titleScore * 0.45 + artistScore * 0.35 + durationScore * 0.15 + (official ? 0.05 : 0);
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
          source_type: /topic/iu.test(`${entry.uploader ?? ""} ${entry.channel ?? ""}`) ? "topic" : official ? "song" : "unofficial",
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
