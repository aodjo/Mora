import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

interface RpcResponse<T> {
  id: number;
  result?: T;
  error?: { code: string; message: string };
}
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: ReturnType<typeof setTimeout> | undefined;
}
export interface MlArtifact {
  kind: string;
  path: string;
  content_type: string;
  speaker_id?: number;
}
export interface MlVariantResult {
  variant_id: string;
  line_spans: Array<[number, number]>;
  word_spans: Array<[number, number, number, number]>;
  quality: Record<string, number>;
}
export interface MlRunResult {
  backend: string;
  hardware: string;
  detected_languages: string[];
  variants: MlVariantResult[];
  speaker_turns: Array<[number, number, number, number]>;
  word_speakers: Array<[string, number, number, number]>;
  line_speakers: Array<[string, number, number, number]>;
  artifacts: MlArtifact[];
  quality: Record<string, number>;
  work_dir: string;
}

export class MlDaemon {
  readonly #process: ChildProcessWithoutNullStreams;
  #id = 0;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #stderrTail: string[] = [];
  onStage: ((value: { stage: string; state: string; progress: number; metrics: Record<string, number> }) => void) | undefined;
  constructor(
    command = process.env.MORA_PYTHON ?? "python3",
    script = process.env.MORA_ML_DAEMON_SCRIPT ?? resolve(process.cwd(), "Generator/python/mora_ml_daemon.py"),
  ) {
    this.#process = spawn(command, [script], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    // Python/ML libraries are noisy on stderr, but stderr is also where a crashed pipeline
    // leaves its traceback. Draining it blind meant every failure surfaced as the bare code
    // ML_PIPELINE_FAILED and the reason vanished — so the tail is kept, to hand back with
    // the error it explains. Reading it keeps the pipe from filling either way.
    const stderrLines = createInterface({ input: this.#process.stderr });
    stderrLines.on("line", (line) => {
      this.#stderrTail.push(line);
      if (this.#stderrTail.length > 60) this.#stderrTail.shift();
    });
    const lines = createInterface({ input: this.#process.stdout });
    lines.on("line", (line) => {
      try {
        const response = JSON.parse(line) as RpcResponse<unknown> & {
          method?: string;
          params?: { stage: string; state: string; progress: number; metrics: Record<string, number> };
        };
        if (response.method === "stage" && response.params !== undefined) {
          this.onStage?.(response.params);
          return;
        }
        const pending = this.#pending.get(response.id);
        if (!pending) return;
        this.#pending.delete(response.id);
        if (pending.timeout !== undefined) clearTimeout(pending.timeout);
        response.error ? pending.reject(this.#failure(response.error.code)) : pending.resolve(response.result);
      } catch {
        /* daemon stdout is protocol-only */
      }
    });
    this.#process.on("error", (error) => this.#rejectAll(error));
    this.#process.on("exit", (code) => this.#rejectAll(new Error(`ML_DAEMON_EXIT_${code}`)));
  }
  /** The error, carrying the last of what Python said before it died. */
  #failure(code: string): Error {
    const said = this.#stderrTail
      .filter((line) => line.trim().length > 0)
      .slice(-12)
      .join("\n");
    const error = new Error(code);
    if (said.length > 0) (error as Error & { detail?: string }).detail = said;
    return error;
  }

  call<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    const id = ++this.#id;
    return new Promise<T>((resolve, reject) => {
      const timeout =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.#pending.delete(id);
              reject(new Error(`ML_DAEMON_TIMEOUT_${method.toUpperCase()}`));
            }, timeoutMs);
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject, timeout });
      this.#process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (error === null || error === undefined) return;
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        if (pending.timeout !== undefined) clearTimeout(pending.timeout);
        pending.reject(error);
      });
    });
  }
  selfTest(): Promise<{
    backend: string;
    hardware: string;
    checks: Record<string, string>;
    production_ready: boolean;
    backend_reason?: string;
  }> {
    return this.call("self_test", {}, 120_000);
  }
  run(params: unknown): Promise<MlRunResult> {
    return this.call("run_job", params);
  }
  close(): void {
    this.#process.kill("SIGTERM");
  }
  #rejectAll(error: unknown): void {
    for (const pending of this.#pending.values()) {
      if (pending.timeout !== undefined) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
