import type {
  AlignmentSource,
  Fingerprint,
  IndexedTimeSpan,
  StoredAlignment,
  TimeSpan,
  SpeakerTurn,
  SpeakerIndex,
} from "../shared/types.js";

export interface RecordingIdentifier {
  isrc?: string;
  mbid?: string;
  artist?: string;
  title?: string;
  durationMs?: number;
}

export interface Contribution {
  isrc: string;
  mbid?: string;
  durationMs?: number;
  tokenizer: string;
  textHash: string;
  fingerprint: Fingerprint;
  lineSpans: TimeSpan[];
  wordSpans: IndexedTimeSpan[];
  source: AlignmentSource;
  contributor?: string;
  speakerTurns?: SpeakerTurn[];
  wordSpeakers?: SpeakerIndex[];
  lineSpeakers?: SpeakerIndex[];
  qualityScore?: number;
}

export interface AlignmentRepository {
  findAlignments(identifier: RecordingIdentifier): Promise<StoredAlignment[]> | StoredAlignment[];
  contribute(value: Contribution): Promise<number> | number;
}
