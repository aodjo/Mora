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
  | { state: "processing"; jobId: string; song?: string }
  /** 어느 단계에 들어섰는가. 단계가 바뀔 때만 오지, 진행률마다 오지는 않는다. */
  | { state: "stage"; song: string; stage: string; progress: number }
  | { state: "done"; song: string; outcome: string; seconds: number }
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

/** 빈 큐를 물어보는 간격의 천장. */
const IDLE_CEILING_MS = 60_000;
/** 심장 소리 사이의 최소 간격. 워커가 죽은 것을 알아채는 데 이 정도면 충분하다. */
const HEARTBEAT_EVERY_MS = 30_000;

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
    // 연달아 빈손으로 돌아온 횟수. 한 곡이라도 잡으면 0 으로 돌아간다.
    let empty = 0;
    let lastBeat = 0;
    let desired = "active";
    while (!this.#stopped) {
      const now = Date.now();
      // 심장 소리는 살아 있다는 말이지 일감을 묻는 것이 아니다. 반복마다 보낼 이유가 없다.
      if (now - lastBeat >= HEARTBEAT_EVERY_MS) {
        desired = (await this.options.admin.heartbeat({ worker_id: this.options.workerId, version: this.options.version })).desired_state;
        lastBeat = now;
        if (!connected) {
          this.options.onStatus?.({ state: "connected", desiredState: desired });
          connected = true;
        }
      }
      if (desired !== "active") {
        empty += 1;
        await delay(this.quiet(empty));
        continue;
      }
      const leased = await this.options.queue.pull();
      if (leased === null) {
        if (!idle) {
          this.options.onStatus?.({ state: "idle" });
          idle = true;
        }
        empty += 1;
        await delay(this.quiet(empty));
        continue;
      }
      idle = false;
      empty = 0;
      this.options.onStatus?.({ state: "processing", jobId: leased.body.job_id });
      await this.process(leased);
    }
  }

  /**
   * 빈 큐를 얼마나 뜸하게 물어볼 것인가.
   *
   * 놀고 있어도 5 초마다 심장 소리 하나와 물음 하나를 보냈다 — 워커 한 대가 하루 34,560 번,
   * 세 대면 103,680 번이다. Cloudflare 무료 플랜의 하루 한도가 100,000 번이라, 아무 일도
   * 하지 않는 것만으로 Worker 가 꺼졌고 관리 화면과 공개 API 가 함께 멎었다.
   *
   * 일감이 있을 때는 빨라야 하고 없을 때는 느려도 된다. 처음 빈손일 때는 그대로 5 초이므로
   * 한 곡을 끝내고 다음 곡을 집는 속도는 달라지지 않는다. 계속 비어 있으면 1 분까지 물러난다 —
   * 그때 워커 한 대는 하루 4,320 번이다.
   */
  private quiet(empty: number): number {
    const base = this.options.idleMs ?? 5000;
    // 천장에 닿는 데 필요한 만큼만 곱한다 — 하루를 놀면 empty 가 천을 넘고, 그때 2**999 를
    // 셈해 봐야 어차피 천장으로 잘린다.
    const doublings = Math.min(Math.max(0, empty - 1), Math.ceil(Math.log2(IDLE_CEILING_MS / base)) + 1);
    return Math.min(IDLE_CEILING_MS, base * 2 ** doublings);
  }
  private async process(leased: LeasedMessage): Promise<void> {
    let input: GeneratorJobInput | undefined;
    let succeeded = false;
    let retrying = false;
    // Derived from the job id rather than a fresh temp dir, so a retry lands on the
    // directory the previous attempt filled and can skip work it already paid for.
    const workDir = join(process.env.MORA_WORK_ROOT ?? tmpdir(), `mora-${leased.body.job_id}`);
    const began = Date.now();
    let song = leased.body.job_id;
    try {
      input = await this.options.admin.job(leased.body.job_id);
      const current = input;
      // 작업 번호만으로는 무엇이 도는지 알 수 없다. 곡 이름을 알아낸 즉시 다시 알린다.
      song = `${input.recording.artist} - ${input.recording.title}`;
      this.options.onStatus?.({ state: "processing", jobId: input.job_id, song });
      let entered = "";
      this.options.daemon.onStage = (value) => {
        // 진행률은 초마다 오지만 단계는 곡당 열 번쯤 바뀐다. 바뀔 때만 말한다.
        if (value.stage !== entered) {
          entered = value.stage;
          this.options.onStatus?.({ state: "stage", song, stage: value.stage, progress: value.progress ?? 0 });
        }
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
          const points = Array.from(variant.text);
          const kept = tokenization.lines.filter((line) => !line.excluded && line.tokenIndices.length > 0);
          return {
            ...variant,
            token_counts: kept.map((line) => line.tokenIndices.length),
            // 세는 것만 보내면 파이썬은 낱말을 제 손으로 다시 갈라야 하고, 그 방식은 여기와
            // 다르다. 일본어는 띄어쓰기가 없어 line.split() 이 한 줄을 낱말 하나로 세는데
            // 여기서는 여섯에서 열로 나뉜다 — 두 셈이 어긋나면 파이썬이 매기는 토큰 번호가
            // word_spans 를 읽는 쪽이 기대하는 번호와 달라진다. 머리글이 있는 가사에서도
            // 줄 수가 맞지 않아 같은 일이 벌어졌다. 잘라 놓은 것을 그대로 보낸다.
            token_lines: kept.map((line) => ({
              text: points.slice(line.start, line.end).join(""),
              words: line.tokenIndices.map((index) => tokenization.tokens[index]?.canonical ?? ""),
              // 낱말이 줄의 어디에 놓였는지. 괄호는 토큰에서 떨어져 나가므로 — "(꺼져)" 의
              // canonical 은 "꺼져" 다 — 어느 낱말이 괄호 안이었는지는 자리를 알아야 안다.
              spans: line.tokenIndices.map((index) => [
                (tokenization.tokens[index]?.start ?? line.start) - line.start,
                (tokenization.tokens[index]?.end ?? line.start) - line.start,
              ]),
            })),
          };
        }),
      };
      const result = await this.options.daemon.run({
        job: prepared,
        cookie_file: process.env.YTDLP_COOKIE_FILE ?? null,
        proxy: process.env.YTDLP_PROXY ?? null,
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
      await this.settle(() => this.options.queue.ack(leased.leaseId));
      succeeded = true;
      this.options.onStatus?.({ state: "done", song, outcome: "후보 제출", seconds: (Date.now() - began) / 1000 });
    } catch (error) {
      this.options.onStatus?.({ state: "done", song, outcome: safeCode(error), seconds: (Date.now() - began) / 1000 });
      if (input !== undefined) await this.sendFailure(input, error);
      // 파이썬이 죽기 전에 남긴 말 — 코드 하나만 보고는 아무것도 고칠 수 없다.
      const detail = (error as Error & { detail?: string }).detail;
      if (detail !== undefined) this.options.onStatus?.({ state: "warning", message: `파이프라인 실패 원인:\n${detail}` });
      retrying = leased.attempts < 3 && !SETTLED_BY_THE_INPUT.has(safeCode(error));
      if (retrying)
        await this.settle(() => this.options.queue.retry(leased.leaseId, Math.min(300, 30 * 2 ** Math.max(0, leased.attempts - 1))));
      else await this.settle(() => this.options.queue.ack(leased.leaseId));
    } finally {
      this.options.daemon.onStage = undefined;
      if (!retrying) await fs.rm(workDir, { recursive: true, force: true });
      // Only on success: a failure already reported cleanup, and reporting it twice would erase the error.
      if (succeeded && input !== undefined) await this.sendStage(input, "cleanup", "completed", 1);
    }
  }
  /**
   * Closing the lease is the last word about work that is already finished.
   *
   * It can fail for reasons that say nothing about the job — the lease outlived a long song,
   * the network blinked, the job was deleted while it ran — and the timings are on the server
   * either way. Ending the process there stopped a Generator that was working, and left every
   * queued song waiting for someone to start it again. An unclosed lease returns to the queue
   * on its own, so this is worth a line in the log and nothing more.
   */
  private async settle(close: () => Promise<unknown>): Promise<void> {
    try {
      await close();
    } catch (error) {
      this.options.onStatus?.({
        state: "warning",
        message: `큐 정리 실패 (${error instanceof Error ? error.message : "UNKNOWN"}) — 작업은 끝났고, 리스는 서버에서 회수됩니다.`,
      });
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
    // 길면 잘라 보낸다 — 진단은 첫 몇 줄에 있고, 이벤트 한 건이 무한정 커지면 안 된다.
    const said = detailOf(error);

    const value: StageEvent = {
      job_id: input.job_id,
      attempt_id: input.attempt_id,
      stage: "cleanup",
      state: "failed",
      code: safeCode(error),
      // 파이썬이 남긴 말은 여기까지 와 있었는데 콘솔에만 찍고 버렸다. 서버에 없으면 나중에
      // 왜 멈췄는지 물을 데가 없다 — 실제로 118번 실패하는 동안 남은 것은 코드 하나뿐이었다.
      ...(said === undefined ? {} : { detail: said }),
      at: Date.now(),
    };
    try {
      await this.options.admin.event(value);
    } catch {
      /* queue retry remains source of recovery */
    }
  }
}
/** 파이썬이 죽기 전에 남긴 말, 이벤트 한 건에 실을 만한 길이로. */
function detailOf(error: unknown): string | undefined {
  const said = (error as Error & { detail?: string }).detail;
  if (typeof said !== "string" || said.trim().length === 0) return undefined;
  return said.length > 1000 ? `${said.slice(0, 1000)}…` : said;
}

/**
 * Failures the job's own input decides, which the same input will reach again every attempt.
 *
 * A language the aligner has no model for is one. A source with no singing on it is the other:
 * labels post the backing track from the artist's own channel as "(Inst.)", it outranks the real
 * upload, and separating it yields a voice 60 dB under the mix. Three attempts at that is three
 * downloads and three separations to arrive at the same word.
 */
const SETTLED_BY_THE_INPUT = new Set(["UNSUPPORTED_LANGUAGE", "NO_VOCAL_TRACK"]);

function safeCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "UNKNOWN";
  return /^[A-Z0-9_]+$/u.test(message) ? message.slice(0, 100) : "PIPELINE_FAILED";
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
