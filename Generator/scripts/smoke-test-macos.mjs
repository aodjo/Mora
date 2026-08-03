import { execFile, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url));
const venv = join(root, "Generator/.venv");
const python = join(venv, "bin/python");
const directory = await mkdtemp(join(tmpdir(), "mora-macos-smoke-"));
const speech = join(directory, "speech.aiff");
const sample = join(directory, "sample.wav");
let daemon;
let server;

try {
  await exec("say", ["-o", speech, "Hello Mora. This is a local processing test for word timing."]);
  await exec("ffmpeg", ["-y", "-i", speech, "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100:duration=8", "-filter_complex", "[1:a]volume=0.025[bg];[0:a][bg]amix=inputs=2:duration=longest", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", sample]);
  const probe = await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", sample]);
  const durationMs = Math.round(Number(probe.stdout.trim()) * 1000);

  server = createServer(async (request, response) => {
    if (request.url !== "/sample.wav") { response.writeHead(404).end(); return; }
    const info = await stat(sample);
    response.writeHead(200, { "content-type": "audio/wav", "content-length": info.size });
    createReadStream(sample).pipe(response);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("smoke HTTP server did not start");

  daemon = spawn(python, [join(root, "Generator/python/mora_ml_daemon.py")], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${join(venv, "bin")}:${process.env.PATH ?? ""}`,
      PYTORCH_ENABLE_MPS_FALLBACK: "1",
      MORA_MLX_WHISPER_MODEL: "mlx-community/whisper-tiny-mlx",
      HF_HOME: process.env.HF_HOME ?? join(process.env.HOME ?? directory, "Library/Caches/Mora/huggingface"),
      TORCH_HOME: process.env.TORCH_HOME ?? join(process.env.HOME ?? directory, "Library/Caches/Mora/torch"),
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: daemon.stdout });
  let identifier = 0;
  const pending = new Map();
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); }
    catch { process.stderr.write(`[daemon] ${line}\n`); return; }
    if (message.method === "stage") {
      process.stderr.write(`[${message.params.stage}] ${message.params.state} ${Math.round(message.params.progress * 100)}%\n`);
      return;
    }
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.code)) : waiter.resolve(message.result);
  });
  const call = (method, params, timeoutMs = 20 * 60_000) => new Promise((resolve, reject) => {
    const id = ++identifier;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
    pending.set(id, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject: (error) => { clearTimeout(timeout); reject(error); } });
    daemon.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

  const selfTest = await call("self_test", {});
  if (selfTest.backend !== "mps" || !selfTest.production_ready) throw new Error(`Mac worker is not production ready: ${JSON.stringify(selfTest)}`);
  const result = await call("run_job", {
    job: {
      job_id: "mac-smoke",
      attempt_id: "mac-smoke-attempt",
      input_revision_id: "mac-smoke-input",
      recording: { isrc: "SMOKETEST0001", artist: "Mora", title: "Mac smoke test", duration_ms: durationMs, language: "en" },
      source: { url: `http://127.0.0.1:${address.port}/sample.wav`, alternatives: [], max_duration_ms: 60_000 },
      lyrics: [{ id: "smoke-lyrics", provider: "local", language: "en", text: "Hello Mora. This is a local processing test for word timing.", preprocessing_version: "smoke", token_counts: [11] }],
      pipeline: { version: "smoke-v1", profile: "smoke-v1" },
    },
    cookie_file: null,
    work_root: directory,
  });
  if (result.backend !== "mps" || result.variants?.[0]?.word_spans?.length === 0 || result.artifacts?.length === 0) throw new Error(`invalid smoke result: ${JSON.stringify(result)}`);
  process.stdout.write(`${JSON.stringify({ backend: result.backend, hardware: result.hardware, detected_languages: result.detected_languages, word_spans: result.variants[0].word_spans.length, artifacts: result.artifacts.map((item) => item.kind), quality: result.quality }, null, 2)}\n`);
} finally {
  daemon?.kill("SIGTERM");
  if (server !== undefined) await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
