import type { LyricsProvider } from "../../packages/contracts/src/index.js";

export interface RecordingSeed {
  artist: string;
  title: string;
  album?: string | undefined;
  duration_ms?: number | undefined;
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
}
