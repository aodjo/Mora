import type { LyricsProvider } from "../../packages/contracts/src/index.js";

export interface RecordingSeed {
  artist: string;
  title: string;
  album?: string | undefined;
  duration_ms?: number | undefined;
  /**
   * Length taken from the catalogue entry that carries the ISRC we publish under, and therefore
   * the length the released master actually runs to. Absent when nothing authoritative answered,
   * which is the difference between a source we can trust and one only a person should approve.
   */
  catalogue_duration_ms?: number | undefined;
  mbid?: string | undefined;
  isrc?: string | undefined;
  language?: string | undefined;
  popularity: number;
  freshness: number;
  market: "KR" | "US" | "JP";
}

export interface YoutubeCandidate {
  url: string;
  video_id: string;
  title: string;
  artist: string;
  album?: string | undefined;
  duration_ms: number;
  official: boolean;
  source_type: "song" | "topic" | "unofficial";
  score: number;
  /** Gap from the catalogue length, or undefined when there was nothing authoritative to check. */
  catalogue_drift_ms?: number | undefined;
}

export interface CollectorConfig {
  adminUrl: string;
  adminToken: string;
  userAgent: string;
  dailyBudget: number;
  markets: Array<"KR" | "US" | "JP">;
  lyricsProvider: LyricsProvider;
  fetch?: typeof globalThis.fetch;
  youtubeSearch?: (seed: RecordingSeed) => Promise<YoutubeCandidate[]>;
  spotify?: { identify: (seed: RecordingSeed) => Promise<{ isrc?: string; durationMs?: number; album?: string } | undefined> };
  onProgress?: (progress: CollectorProgress) => void;
}

export type CollectorProgress =
  | { stage: "discovering"; markets: Array<"KR" | "US" | "JP"> }
  | { stage: "selected"; total: number }
  | { stage: "processing"; current: number; total: number; song: string }
  | {
      stage: "delivered";
      current: number;
      total: number;
      song: string;
      destination: "generator" | "review";
      reason?: string;
      jobId?: string;
      deduplicated: boolean;
    }
  | { stage: "skipped"; current: number; total: number; song: string; reason: "instrumental" | "no-lyrics" }
  | { stage: "failed"; current: number; total: number; song: string; code: string };
