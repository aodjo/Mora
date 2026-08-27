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

/**
 * 지금 곡을 잡고 있는가를 바깥에서 읽을 수 있게 남긴다.
 *
 * 새 판이 나오면 워커를 갈아타야 하는데, worker.stop() 은 데몬을 곧바로 닫으므로 작업 중에
 * 끊으면 그 곡을 잃는다. 감독하는 쪽은 "지금 한가한가"를 알아야 하고, 그것을 로그 꼬리로
 * 짐작하면 형식이 바뀔 때마다 조용히 틀린다. 파일 하나로 말해 준다.
 */
const busyFile = process.env.MORA_BUSY_FILE ?? resolve(process.cwd(), "Generator/.mora-worker.busy");
let busy: boolean | null = null;
function markBusy(next: boolean): void {
  if (busy === next) return;
  busy = next;
  void writeFile(busyFile, next ? "busy" : "idle", "utf8").catch(() => {});
}

try {
  process.stdout.write("Generator 환경을 확인하는 중…\n");
  const selfTest = await daemon.selfTest();
  if (process.env.MORA_SELF_TEST === "1") {
    process.stdout.write(`${JSON.stringify(selfTest, null, 2)}\n`);
    daemon.close();
    process.exit(selfTest.production_ready ? 0 : 1);
  }
  // 무엇이 걸렸는지 말하지 않으면 고칠 수가 없다. 대개는 PATH 에 없는 도구 하나다.
  if (!selfTest.production_ready) {
    const failed = Object.entries(selfTest.checks ?? {})
      .filter(([, value]) => value !== "passed" && value !== "skipped")
      .map(([name]) => name);
    const why =
      failed.length > 0
        ? `준비되지 않은 항목: ${failed.join(", ")}`
        : (selfTest.backend_reason ?? `가속기를 찾지 못했습니다 (backend=${selfTest.backend})`);
    throw new Error(`Generator 환경 확인 실패 — ${why}`);
  }
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
  /** 파이프라인 단계를 사람이 읽는 말로. 화면에 뜨는 것은 코드가 아니라 지금 하는 일이어야 한다. */
  const STAGE_NAMES: Record<string, string> = {
    probe: "살펴보는 중",
    download: "내려받는 중",
    transcode: "변환하는 중",
    separate: "목소리 가르는 중",
    coarse_asr: "받아쓰는 중",
    split_voices: "곁소리 가르는 중",
    language_validate: "언어 확인",
    forced_align: "맞춰 놓는 중",
    diarize: "누가 부르는지",
    speaker_stems: "목소리별로 가르는 중",
    index: "지문 만드는 중",
    quality_gate: "품질 재는 중",
    candidate_submit: "올리는 중",
    cleanup: "정리",
  };

  const worker = new GeneratorWorker({
    workerId,
    version: "0.1.0",
    admin,
    queue: new AdminJobQueue(admin),
    daemon,
    artifactPublicKey: await readArtifactPublicKey(),
    onStatus: (status) => {
      // 지금 곡을 잡고 있는지를 파일로 남긴다. worker.stop() 은 데몬을 곧바로 닫으므로 작업
      // 중에 끊으면 그 곡을 잃는다 — 새 판이 나왔을 때 감독 스크립트가 언제 갈아탈지 알려면
      // 바깥에서 읽을 수 있는 표시가 있어야 한다. 로그 꼬리를 훑어 짐작하는 것보다 낫다.
      if (status.state === "idle" || status.state === "done") markBusy(false);
      else if (status.state === "processing" || status.state === "stage") markBusy(true);
      if (status.state === "connected") {
        const suffix = status.desiredState === "active" ? "" : ` (서버 상태: ${status.desiredState})`;
        process.stdout.write(`Admin 연결 완료: ${adminUrl}${suffix}\n`);
      } else if (status.state === "idle") {
        process.stdout.write("Generator 실행 중: 처리할 작업을 기다립니다. 종료하려면 Ctrl+C를 누르세요.\n");
      } else if (status.state === "warning") {
        process.stdout.write(`${status.message}\n`);
      } else if (status.state === "stage") {
        process.stdout.write(`   ${STAGE_NAMES[status.stage] ?? status.stage} ${Math.round(status.progress * 100)}%\n`);
      } else if (status.state === "done") {
        const mark = status.outcome === "후보 제출" ? "✔" : "✖";
        process.stdout.write(`${mark} ${status.song} — ${status.outcome} · ${status.seconds.toFixed(0)}초\n`);
      } else if (status.song !== undefined) {
        process.stdout.write(`\n▶ ${status.song}\n`);
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
