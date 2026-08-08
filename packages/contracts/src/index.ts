export const JOB_SCHEMA_VERSION = 1 as const;

export type JobState =
  "queued" | "claimed" | "running" | "review_required" | "unsupported_language" | "candidate_ready" | "published" | "failed" | "cancelled";

export type PipelineStage =
  | "probe"
  | "download"
  | "transcode"
  | "separate"
  | "coarse_asr"
  | "language_validate"
  | "forced_align"
  | "diarize"
  | "speaker_stems"
  | "index"
  | "quality_gate"
  | "candidate_submit"
  | "cleanup";

export type ArtifactKind = "source" | "mixture_preview" | "vocals" | "drums" | "bass" | "other" | "speaker" | "waveform" | "checkpoint";

export interface QueueJobMessage {
  schema_version: typeof JOB_SCHEMA_VERSION;
  job_id: string;
  input_revision_id: string;
}

export interface LyricsVariantInput {
  id: string;
  provider: string;
  provider_ref?: string;
  language: string;
  text: string;
  preprocessing_version: string;
}

export interface GeneratorJobInput {
  schema_version: typeof JOB_SCHEMA_VERSION;
  job_id: string;
  attempt_id: string;
  input_revision_id: string;
  recording: {
    isrc: string;
    mbid?: string;
    artist: string;
    title: string;
    album?: string;
    duration_ms: number;
    language: string;
  };
  source: {
    url: string;
    alternatives: string[];
    max_duration_ms: number;
  };
  lyrics: LyricsVariantInput[];
  pipeline: {
    version: string;
    profile: string;
    min_speakers?: number;
    max_speakers?: number;
  };
}

export type LineSpan = [startMs: number, endMs: number];
export type WordSpan = [tokenIndex: number, startMs: number, endMs: number, confidence: number];
export type SpeakerTurn = [speakerId: number, startMs: number, endMs: number, confidence: number];
export type SpeakerIndex = [index: number, speakerId: number, confidence: number];

export interface AlignmentCandidate {
  variant_id: string;
  tokenizer: "unilab-v1" | "unilab-v2";
  text_hash: string;
  fingerprint: { lens: number[][]; types: Array<Array<0 | 1 | 2 | 3>> };
  line_spans: LineSpan[];
  word_spans: WordSpan[];
  speaker_turns: SpeakerTurn[];
  word_speakers: SpeakerIndex[];
  line_speakers: SpeakerIndex[];
  quality: Record<string, number>;
}

export interface GeneratorCandidateSubmission {
  schema_version: typeof JOB_SCHEMA_VERSION;
  job_id: string;
  attempt_id: string;
  input_revision_id: string;
  pipeline_version: string;
  backend: string;
  hardware: string;
  detected_languages: string[];
  alignments: AlignmentCandidate[];
  artifact_ids: string[];
  quality: Record<string, number>;
}

export interface StageEvent {
  job_id: string;
  attempt_id: string;
  stage: PipelineStage;
  state: "started" | "progress" | "completed" | "failed";
  progress?: number;
  code?: string;
  metrics?: Record<string, number>;
  at: number;
}

export interface WorkerCapabilities {
  worker_id: string;
  version: string;
  backend: "mps" | "cuda" | "xpu" | "rocm";
  hardware: string;
  capabilities: string[];
  production_ready: boolean;
  self_test: Record<string, "passed" | "failed" | "skipped">;
}

export interface LyricsProviderResult {
  provider: string;
  provider_ref?: string;
  text: string;
  language?: string;
  fetched_at: number;
}

export interface LyricsProvider {
  search(input: { isrc?: string; mbid?: string; artist: string; title: string; album?: string }): Promise<LyricsProviderResult[]>;
}

export function isQueueJobMessage(value: unknown): value is QueueJobMessage {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    item.schema_version === JOB_SCHEMA_VERSION &&
    typeof item.job_id === "string" &&
    item.job_id.length > 0 &&
    typeof item.input_revision_id === "string" &&
    item.input_revision_id.length > 0
  );
}
