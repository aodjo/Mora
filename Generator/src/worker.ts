import { fingerprint, textHash } from "../../packages/core/src/tokenization/fingerprint.js";
import { tokenizeV2 } from "../../packages/core/src/tokenization/tokenizer-v2.js";
import type {
  AlignmentCandidate,
  GeneratorCandidateSubmission,
  GeneratorJobInput,
  PipelineStage,
  StageEvent,
} from "../../packages/contracts/src/index.js";
import { JOB_SCHEMA_VERSION } from "../../packages/contracts/src/index.js";
import { AdminClient } from "./admin-client.js";
import type { GeneratorQueue, LeasedMessage } from "./queue.js";
import { MlDaemon } from "./ml-daemon.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type GeneratorWorkerStatus =
  | { state: "connected"; desiredState: string }
  | { state: "idle" }
  | { state: "processing"; jobId: string }
  /** Something went wrong that the run survived — worth saying, not worth stopping for. */
  | { state: "warning"; message: string };
export interface GeneratorWorkerOptions {
  workerId: string;
  version: string;
  admin: AdminClient;
  queue: GeneratorQueue;
  daemon: MlDaemon;
  artifactPublicKey: string;
  idleMs?: number;
  onStatus?: (status: GeneratorWorkerStatus) => void;
}

export class GeneratorWorker {
  #stopped = false;
  constructor(readonly options: GeneratorWorkerOptions) {}
  stop(): void {
    this.#stopped = true;
    this.options.daemon.close();
  }
  async run(): Promise<void> {
    let connected = false;
    let idle = false;
    while (!this.#stopped) {
      const heartbeat = await this.options.admin.heartbeat({ worker_id: this.options.workerId, version: this.options.version });
      if (!connected) {
        this.options.onStatus?.({ state: "connected", desiredState: heartbeat.desired_state });
        connected = true;
      }
      if (heartbeat.desired_state !== "active") {
        await delay(5000);
        continue;
      }
      const leased = await this.options.queue.pull();
      if (leased === null) {
        if (!idle) {
          this.options.onStatus?.({ state: "idle" });
          idle = true;
        }
        await delay(this.options.idleMs ?? 5000);
        continue;
      }
      idle = false;
      this.options.onStatus?.({ state: "processing", jobId: leased.body.job_id });
      await this.process(leased);
    }
  }
  private async process(leased: LeasedMessage): Promise<void> {
    let input: GeneratorJobInput | undefined;
    let succeeded = false;
    let retrying = false;
    // Derived from the job id rather than a fresh temp dir, so a retry lands on the
    // directory the previous attempt filled and can skip work it already paid for.
    const workDir = join(process.env.MORA_WORK_ROOT ?? tmpdir(), `mora-${leased.body.job_id}`);
    try {
      input = await this.options.admin.job(leased.body.job_id);
      const current = input;
      this.options.daemon.onStage = (value) => {
        // Progress is telling the console what is happening; it is not the work. A rejected
        // report used to leave an unhandled rejection, which takes the whole process down and
        // loses the job that was mid-flight — a job that is running fine.
        void this.options.admin
          .event({
            job_id: current.job_id,
            attempt_id: current.attempt_id,
            stage: value.stage as PipelineStage,
            state: value.state as "started" | "progress" | "completed" | "failed",
            progress: value.progress,
            metrics: value.metrics,
            at: Date.now(),
          })
          .catch((error: unknown) => {
            this.options.onStatus?.({
              state: "warning",
              message: `단계 보고 실패 (${error instanceof Error ? error.message : "UNKNOWN"})`,
            });
          });
      };
      const prepared = {
        ...input,
        lyrics: input.lyrics.map((variant) => {
          const tokenization = tokenizeV2(variant.text, variant.language);
          return {
            ...variant,
            token_counts: tokenization.lines
              .filter((line) => !line.excluded && line.tokenIndices.length > 0)
              .map((line) => line.tokenIndices.length),
          };
        }),
      };
      const result = await this.options.daemon.run({
        job: prepared,
        cookie_file: process.env.YTDLP_COOKIE_FILE ?? null,
        work_dir: workDir,
      });
      const artifactIds: string[] = [];
      for (const artifact of result.artifacts) {
        artifactIds.push(
          await this.options.admin.uploadArtifact({
            jobId: input.job_id,
            kind: artifact.kind,
            path: artifact.path,
            contentType: artifact.content_type,
            publicKey: this.options.artifactPublicKey,
            ...(artifact.speaker_id === undefined ? {} : { speakerId: artifact.speaker_id }),
          }),
        );
      }
      const byVariant = new Map(result.variants.map((item) => [item.variant_id, item]));
      const speakerWords = new Map<string, Array<[number, number, number]>>();
      const speakerLines = new Map<string, Array<[number, number, number]>>();
      for (const [variant, index, speaker, confidence] of result.word_speakers) {
        const rows = speakerWords.get(variant) ?? [];
        rows.push([index, speaker, confidence]);
        speakerWords.set(variant, rows);
      }
      for (const [variant, index, speaker, confidence] of result.line_speakers) {
        const rows = speakerLines.get(variant) ?? [];
        rows.push([index, speaker, confidence]);
        speakerLines.set(variant, rows);
      }
      const alignments: AlignmentCandidate[] = input.lyrics.flatMap((variant) => {
        const timed = byVariant.get(variant.id);
        if (timed === undefined) return [];
        const tokens = tokenizeV2(variant.text, variant.language);
        return [
          {
            variant_id: variant.id,
            tokenizer: "unilab-v2",
            text_hash: textHash(tokens.canonical),
            fingerprint: fingerprint(tokens),
            line_spans: timed.line_spans,
            word_spans: timed.word_spans,
            speaker_turns: result.speaker_turns,
            word_speakers: speakerWords.get(variant.id) ?? [],
            line_speakers: speakerLines.get(variant.id) ?? [],
            quality: timed.quality,
          },
        ];
      });
      const submission: GeneratorCandidateSubmission = {
        schema_version: JOB_SCHEMA_VERSION,
        job_id: input.job_id,
        attempt_id: input.attempt_id,
        input_revision_id: input.input_revision_id,
        pipeline_version: input.pipeline.version,
        backend: result.backend,
        hardware: result.hardware,
        detected_languages: result.detected_languages,
        alignments,
        artifact_ids: artifactIds,
        quality: result.quality,
      };
      await this.sendStage(input, "candidate_submit", "started", 0.97);
      await this.options.admin.candidates(submission);
      await this.sendStage(input, "candidate_submit", "completed", 0.99);
      await this.options.queue.ack(leased.leaseId);
      succeeded = true;
    } catch (error) {
      if (input !== undefined) await this.sendFailure(input, error);
      // A language the aligner has no model for will fail again on every attempt.
      retrying = leased.attempts < 3 && safeCode(error) !== "UNSUPPORTED_LANGUAGE";
      if (retrying) await this.options.queue.retry(leased.leaseId, Math.min(300, 30 * 2 ** Math.max(0, leased.attempts - 1)));
      else await this.options.queue.ack(leased.leaseId);
    } finally {
      this.options.daemon.onStage = undefined;
      if (!retrying) await fs.rm(workDir, { recursive: true, force: true });
      // Only on success: a failure already reported cleanup, and reporting it twice would erase the error.
      if (succeeded && input !== undefined) await this.sendStage(input, "cleanup", "completed", 1);
    }
  }
  private async sendStage(
    input: GeneratorJobInput,
    stage: PipelineStage,
    state: "started" | "progress" | "completed" | "failed",
    progress: number,
  ): Promise<void> {
    try {
      await this.options.admin.event({ job_id: input.job_id, attempt_id: input.attempt_id, stage, state, progress, at: Date.now() });
    } catch {
      /* progress reporting must never fail the job */
    }
  }
  private async sendFailure(input: GeneratorJobInput, error: unknown): Promise<void> {
    const value: StageEvent = {
      job_id: input.job_id,
      attempt_id: input.attempt_id,
      stage: "cleanup",
      state: "failed",
      code: safeCode(error),
      at: Date.now(),
    };
    try {
      await this.options.admin.event(value);
    } catch {
      /* queue retry remains source of recovery */
    }
  }
}
function safeCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "UNKNOWN";
  return /^[A-Z0-9_]+$/u.test(message) ? message.slice(0, 100) : "PIPELINE_FAILED";
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
