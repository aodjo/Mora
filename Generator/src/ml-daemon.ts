import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { delimiter, resolve } from "node:path";

/**
 * The tools the pipeline runs on live in Generator/.venv, not on the system path.
 *
 * run-macos.sh puts them there before it starts the worker, so anything launched through it
 * works. Anything not launched through it — `npm run dev:generator`, a direct node invocation,
 * a test — got the system python instead, and the daemon then reported yt-dlp, demucs and
 * whisperx all missing, which is true of that python and says nothing about the machine.
 * The daemon knows which interpreter it needs, so it is the one that should ask for it.
 */
const VENV_BIN = resolve(process.cwd(), "Generator/.venv/bin");

function venvPython(): string | undefined {
  const interpreter = resolve(VENV_BIN, "python");
  return existsSync(interpreter) ? interpreter : undefined;
}

function daemonEnvironment(): NodeJS.ProcessEnv {
  // yt-dlp 는 유튜브의 JS 서명을 풀 런타임을 찾는데, 기본으로는 deno 만 본다. node 는 늘
  // 여기 있다 — 이 데몬을 띄우는 것이 node 프로그램이다. 그런데 PATH 에서 찾게 두면, 로그인
  // 셸이 아닌 환경에서는 없다고 나온다 (실측한 박스에서 which node 가 빈 줄이었다). 어디에
  // 있는지 아는 쪽이 말해 준다.
  const base: NodeJS.ProcessEnv = { ...process.env, MORA_NODE: process.env.MORA_NODE ?? process.execPath };
  if (!existsSync(VENV_BIN)) return base;
  const path = base.PATH === undefined ? VENV_BIN : `${VENV_BIN}${delimiter}${base.PATH}`;
  return { ...base, PATH: path };
}

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
    command = process.env.MORA_PYTHON ?? venvPython() ?? "python3",
    script = process.env.MORA_ML_DAEMON_SCRIPT ?? resolve(process.cwd(), "Generator/python/mora_ml_daemon.py"),
  ) {
    this.#process = spawn(command, [script], { stdio: ["pipe", "pipe", "pipe"], env: daemonEnvironment() });
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
