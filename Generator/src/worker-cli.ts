import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { AdminClient } from "./admin-client.js";
import { AdminJobQueue } from "./admin-queue.js";
import { MlDaemon } from "./ml-daemon.js";
import { GeneratorWorker } from "./worker.js";
import { startGeneratorPairing, waitForGeneratorPairing } from "./pairing.js";

interface WorkerCredentials {
  admin_url: string;
  worker_id: string;
  api_key: string;
  created_at: number;
}

const credentialFile = process.env.MORA_CREDENTIAL_FILE ?? resolve(process.cwd(), "Generator/.mora-worker.json");
const daemon = new MlDaemon();

try {
  process.stdout.write("Generator 환경을 확인하는 중…\n");
  const selfTest = await daemon.selfTest();
  if (process.env.MORA_SELF_TEST === "1") {
    process.stdout.write(`${JSON.stringify(selfTest, null, 2)}\n`);
    daemon.close();
    process.exit(selfTest.production_ready ? 0 : 1);
  }
  if (!selfTest.production_ready) throw new Error("worker self-test did not pass the production profile");
  const passedChecks = Object.values(selfTest.checks).filter((value) => value === "passed").length;
  process.stdout.write(
    `Generator 환경 확인 완료: ${selfTest.backend} · ${selfTest.hardware} · ${passedChecks}/${Object.keys(selfTest.checks).length} 검사 통과\n`,
  );

  const adminUrl = process.env.MORA_ADMIN_URL ?? "https://mora.junx.dev";
  let credentials = await readCredentials(credentialFile);
  if (credentials !== undefined && credentials.admin_url !== adminUrl)
    throw new Error(`saved Generator credential belongs to ${credentials.admin_url}`);

  if (credentials === undefined) {
    const workerId = process.env.MORA_WORKER_ID ?? crypto.randomUUID();
    const pairing = await startGeneratorPairing(adminUrl, process.env.MORA_WORKER_NAME ?? `Generator on ${hostname()}`, {
      worker_id: workerId,
      version: "0.1.0",
      backend: selfTest.backend as "mps" | "cuda" | "xpu" | "rocm",
      hardware: selfTest.hardware,
      capabilities: Object.entries(selfTest.checks)
        .filter(([, value]) => value === "passed")
        .map(([key]) => key),
      production_ready: selfTest.production_ready,
      self_test: Object.fromEntries(
        Object.entries(selfTest.checks).map(([key, value]) => [
          key,
          value === "passed" ? "passed" : value === "skipped" ? "skipped" : "failed",
        ]),
      ) as Record<string, "passed" | "failed" | "skipped">,
    });
    const formattedPin = `${pairing.pin.slice(0, 3)} ${pairing.pin.slice(3, 6)} ${pairing.pin.slice(6)}`;
    process.stdout.write("\nGenerator 인증이 필요합니다.\n");
    process.stdout.write(`Admin → 권한·설정 → Generator 연결에 PIN을 입력하세요: ${formattedPin}\n`);
    process.stdout.write("승인을 기다리는 중입니다…\n\n");
    const approved = await waitForGeneratorPairing(adminUrl, pairing);
    credentials = { admin_url: adminUrl, ...approved, created_at: Date.now() };
    await mkdir(dirname(credentialFile), { recursive: true });
    await writeFile(credentialFile, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    await chmod(credentialFile, 0o600);
    process.stdout.write(`Generator 인증 완료: ${credentials.worker_id}\n`);
  }

  const token = process.env.MORA_GENERATOR_TOKEN ?? credentials?.api_key;
  const workerId = process.env.MORA_WORKER_ID ?? credentials?.worker_id;
  if (token === undefined) throw new Error("Generator credential is required");
  if (workerId === undefined) throw new Error("Generator worker ID is required");
  if (credentials !== undefined && process.env.MORA_WORKER_ID !== undefined && credentials.worker_id !== process.env.MORA_WORKER_ID)
    throw new Error("MORA_WORKER_ID does not match the credential file");

  const admin = new AdminClient(adminUrl, token);
  const worker = new GeneratorWorker({
    workerId,
    version: "0.1.0",
    admin,
    queue: new AdminJobQueue(admin),
    daemon,
    artifactPublicKey: await readArtifactPublicKey(),
    onStatus: (status) => {
      if (status.state === "connected") {
        const suffix = status.desiredState === "active" ? "" : ` (서버 상태: ${status.desiredState})`;
        process.stdout.write(`Admin 연결 완료: ${adminUrl}${suffix}\n`);
      } else if (status.state === "idle") {
        process.stdout.write("Generator 실행 중: 처리할 작업을 기다립니다. 종료하려면 Ctrl+C를 누르세요.\n");
      } else {
        process.stdout.write(`작업 처리 시작: ${status.jobId}\n`);
      }
    },
  });
  process.on("SIGINT", () => worker.stop());
  process.on("SIGTERM", () => worker.stop());
  await worker.run();
} catch (error) {
  daemon.close();
  throw error;
}

async function readCredentials(path: string): Promise<WorkerCredentials | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<WorkerCredentials>;
    if (
      typeof value.admin_url !== "string" ||
      typeof value.worker_id !== "string" ||
      typeof value.api_key !== "string" ||
      typeof value.created_at !== "number"
    )
      throw new Error("invalid worker credential file");
    return { admin_url: value.admin_url, worker_id: value.worker_id, api_key: value.api_key, created_at: value.created_at };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readArtifactPublicKey(): Promise<string> {
  if (process.env.MORA_ARTIFACT_PUBLIC_KEY !== undefined) return process.env.MORA_ARTIFACT_PUBLIC_KEY;
  const path = process.env.MORA_ARTIFACT_PUBLIC_KEY_FILE ?? resolve(process.cwd(), "Generator/artifact-public.pem");
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new Error(`artifact public key not found: ${path}`);
  }
}
