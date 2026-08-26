import type { LyricsProvider } from "../../packages/contracts/src/index.js";

import type { CatalogueEntry } from "./lyricfind.js";

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
  /** The release this recording was found on — the door to the rest of its album. */
  release_mbid?: string | undefined;
  isrc?: string | undefined;
  language?: string | undefined;
  /**
   * 노래가 없는 트랙이라고 카탈로그가 밝힌 것.
   *
   * 제목만으로는 놓친다 — 10CM 의 「너에게 닿기를 (Inst.)」은 줄임말 하나로 걸러졌지만,
   * 아무 표시 없이 올라온 반주도 있다. 카탈로그가 아는 것을 굳이 글자에서 다시 알아낼
   * 이유가 없다.
   */
  instrumental?: boolean | undefined;
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
  /** Chart lookup per market — replaceable in tests so they need not serve chart HTML. */
  chartSource?: (market: RecordingSeed["market"]) => Promise<RecordingSeed[]>;
  /** The catalogue: ISRC and track length, keyless. */
  lyricfind?: { identify: (seed: RecordingSeed) => Promise<CatalogueEntry | undefined> };
  onProgress?: (progress: CollectorProgress) => void;
}

export type CollectorProgress =
  | { stage: "discovering"; markets: Array<"KR" | "US" | "JP"> }
  | { stage: "discovered"; total: number; alreadyCollected: number }
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
  | { stage: "skipped"; current: number; total: number; song: string; reason: "instrumental" | "no-lyrics" | "no-source" | "collected" }
  | { stage: "expanded"; album: string; added: number; total: number }
  | { stage: "failed"; current: number; total: number; song: string; code: string };
