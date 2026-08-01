export const TOKENIZER = "unilab-v1" as const;
export const TOKENIZER_V2 = "unilab-v2" as const;
export type TokenizerId = typeof TOKENIZER | typeof TOKENIZER_V2;

export type TokenType = 0 | 1 | 2 | 3;
export type Tier = "word" | "word-approx" | "line" | "none";
export type AlignmentSource = "manual" | "forced-align";

export interface Token {
  start: number;
  end: number;
  line: number;
  length: number;
  type: TokenType;
  canonical: string;
}

export interface TokenizedLine {
  index: number;
  start: number;
  end: number;
  tokenIndices: number[];
  excluded: boolean;
}

export interface Tokenization {
  tokenizer: TokenizerId;
  tokens: Token[];
  lines: TokenizedLine[];
  canonical: string;
}

export interface Fingerprint {
  lens: number[][];
  types: TokenType[][];
}

export type TimeSpan = [startMs: number, endMs: number];
export type IndexedTimeSpan = [tokenIndex: number, startMs: number, endMs: number];
export type OffsetTimeSpan = [start: number, end: number, startMs: number, endMs: number];
export type ProjectedIndexedTimeSpan = [tokenIndex: number, startMs: number, endMs: number, interpolated: 0 | 1];
export type ProjectedOffsetTimeSpan = [start: number, end: number, startMs: number, endMs: number, interpolated: 0 | 1];
export type SpeakerTurn = [speakerId: number, startMs: number, endMs: number, confidence: number];
export type SpeakerIndex = [index: number, speakerId: number, confidence: number];

export interface StoredAlignment {
  id: number;
  isrc: string;
  textHash: string;
  tokenizer: string;
  fingerprint: Fingerprint;
  lineSpans: TimeSpan[];
  wordSpans: IndexedTimeSpan[];
  source: AlignmentSource;
  contributor: string | null;
  createdAt: number;
  durationMs: number | null;
  speakerTurns?: SpeakerTurn[];
  wordSpeakers?: SpeakerIndex[];
  lineSpeakers?: SpeakerIndex[];
  qualityScore?: number;
}

export interface MatchResult {
  confidence: number;
  tier: Tier;
  exactTokens: number;
  matchedLines: number;
  sourceTokenCount: number;
  targetTokenCount: number;
  sourceToTargetTokens: Map<number, number>;
  sourceToTargetLines: Map<number, number>;
}

export interface AlignmentResult {
  tier: Tier;
  confidence: number;
  tokenizer: TokenizerId;
  offset_unit: "codepoint";
  alignment_id: number;
  lines: OffsetTimeSpan[];
  spans: ProjectedOffsetTimeSpan[];
  speaker_turns: SpeakerTurn[];
  word_speakers: SpeakerIndex[];
  line_speakers: SpeakerIndex[];
}

export interface FingerprintAlignmentResult {
  tier: Tier;
  confidence: number;
  tokenizer: TokenizerId;
  alignment_id: number;
  lines: Array<[targetLineIndex: number, startMs: number, endMs: number]>;
  spans: ProjectedIndexedTimeSpan[];
  speaker_turns: SpeakerTurn[];
  word_speakers: SpeakerIndex[];
  line_speakers: SpeakerIndex[];
}
