export const JOB_SCHEMA_VERSION = 1 as const;

export type JobState =
  "queued" | "claimed" | "running" | "review_required" | "unsupported_language" | "candidate_ready" | "published" | "failed" | "cancelled";

export type PipelineStage =
  | "probe"
  | "download"
  | "transcode"
  | "separate"
  | "coarse_asr"
  | "split_voices"
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
  /**
   * 제공처가 줄여 적은 반복을 되살린 가사. 오면 이 후보는 이 글에 맞춰진 것이고, 서버가 그것을
   * 따로 한 벌의 가사로 저장해 후보를 그쪽에 건다 — 원문 가사는 그대로 둔다.
   */
  text?: string;
  /** 되살린 가사에서 새로 끼워 넣은 줄의 자리. 검수 화면이 그 줄을 표시한다. */
  filled?: number[];
  /**
   * 어느 정렬기가 이 타이밍을 냈나.
   *
   * `sung` 은 노래로 학습한 정렬기, `whisperx` 는 애초에 그 길이 아니었던 곡(한국어가 아니거나
   * 무게가 없다), `fallback` 은 **노래 정렬기로 가다가 죽어서 물러선 것**이다. 셋을 뭉치면
   * 물러선 후보가 성한 것과 똑같은 얼굴로 공개된다 — 검정치마 EVERYTHING 이 그랬다.
   */
  aligner?: "sung" | "whisperx" | "fallback";
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
  /** 실패한 단계가 남긴 말. 코드 하나로는 IP 차단과 쿠키 만료와 비공개 영상이 같아 보인다. */
  detail?: string;
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
