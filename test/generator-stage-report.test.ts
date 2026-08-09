import assert from "node:assert/strict";
import test from "node:test";
import { GeneratorWorker, type GeneratorWorkerStatus } from "../Generator/src/worker.js";
import type { AdminClient } from "../Generator/src/admin-client.js";
import type { GeneratorQueue, LeasedMessage } from "../Generator/src/queue.js";
import type { MlDaemon } from "../Generator/src/ml-daemon.js";

const JOB_ID = "7359099f-f0b4-40ad-896e-12319d542d45";

function jobInput() {
  return {
    schema_version: 1,
    job_id: JOB_ID,
    attempt_id: "attempt-1",
    input_revision_id: "rev-1",
    recording: { artist: "Lil Baby", title: "Dead Fresh", isrc: "USUG12600008" },
    url: "https://music.youtube.com/watch?v=mdcjkQvYsgc",
    pipeline: { version: "1.0.0" },
    lyrics: [{ id: "var-1", language: "en", text: "we gonna ride\nall night long" }],
  };
}

/**
 * The run must survive a stage report that fails.
 *
 * It did not: the report was fired and forgotten, so a rejection became an unhandled one and
 * Node ended the process — losing a job that was, by every other measure, running fine. This
 * drives the real worker with an admin whose event() always rejects.
 */
function harness(options: { ackFails?: boolean } = {}): {
  worker: GeneratorWorker;
  seen: GeneratorWorkerStatus[];
  submitted: unknown[];
  acked: string[];
} {
  const seen: GeneratorWorkerStatus[] = [];
  const submitted: unknown[] = [];
  const acked: string[] = [];
  let pulled = false;
  const worker = new GeneratorWorker({
    workerId: "w1",
    version: "0.1.0",
    artifactPublicKey: "key",
    idleMs: 1,
    onStatus: (status) => seen.push(status),
    admin: {
      heartbeat: async () => ({ desired_state: "active" }),
      job: async () => jobInput(),
      // 이 실행에서 단계 보고는 항상 실패한다.
      event: async () => {
        throw new Error('ADMIN_500_/generator/events_{"error":"INTERNAL"}');
      },
      candidates: async (value: unknown) => {
        submitted.push(value);
        return { accepted: true };
      },
      uploadArtifact: async () => "artifact-1",
    } as unknown as AdminClient,
    queue: {
      pull: async (): Promise<LeasedMessage | null> => {
        if (pulled) return null;
        pulled = true;
        return { leaseId: "lease-1", attempts: 1, body: jobInput() } as unknown as LeasedMessage;
      },
      ack: async (leaseId: string) => {
        if (options.ackFails === true) throw new Error('ADMIN_409_/generator/queue/ack_{"error":"CONFLICT"}');
        acked.push(leaseId);
      },
      retry: async () => undefined,
    } as unknown as GeneratorQueue,
    daemon: {
      onStage: undefined,
      close: () => undefined,
      run: async function (this: MlDaemon) {
        // 데몬이 진행 상황을 알린다 — 이 보고가 통째로 실패하는 상황이다.
        this.onStage?.({ stage: "coarse_asr", state: "started", progress: 0.55, metrics: {} });
        this.onStage?.({ stage: "coarse_asr", state: "progress", progress: 0.7, metrics: { rtf: 0.31 } });
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          backend: "mps",
          hardware: "test",
          detected_languages: ["en"],
          artifacts: [],
          speaker_turns: [],
          word_speakers: [],
          line_speakers: [],
          quality: {},
          variants: [{ variant_id: "var-1", line_spans: [[0, 1000]], word_spans: [[0, 0, 500, 0.9]], quality: {} }],
        };
      },
    } as unknown as MlDaemon,
  });
  return { worker, seen, submitted, acked };
}

test("a failing stage report neither stops the job nor kills the process", async () => {
  const raised: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    raised.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  const { worker, seen, submitted, acked } = harness();
  try {
    const running = worker.run();
    await new Promise((resolve) => setTimeout(resolve, 120));
    worker.stop();
    await running;
    // 보고가 실패한 뒤에도 이벤트 루프가 한 바퀴 더 돌아야 미처리 거부가 드러난다.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  assert.deepEqual(raised, [], "단계 보고 실패가 프로세스를 죽이면 안 된다");
  // 그리고 작업은 끝까지 갔다.
  assert.equal(submitted.length, 1, "타이밍 후보가 제출되어야 한다");
  assert.deepEqual(acked, ["lease-1"], "성공한 작업은 큐에서 확인되어야 한다");

  const warnings = seen.filter((status) => status.state === "warning");
  assert.ok(warnings.length > 0, "실패한 보고는 조용히 사라지지 않고 알려져야 한다");
  assert.match(warnings[0]!.message, /단계 보고 실패/u);
  // 어느 엔드포인트였는지가 메시지에 남아야 다음에 쫓아갈 수 있다.
  assert.match(warnings[0]!.message, /\/generator\/events/u);
});

test("a lease that cannot be closed does not stop the Generator", async () => {
  // ack 는 이미 끝난 일에 대한 마지막 한 마디다. 리스가 만료됐거나, 네트워크가 끊겼거나,
  // 작업이 지워졌을 수 있다 — 어느 쪽이든 타이밍은 이미 서버에 있다.
  const raised: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    raised.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  const { worker, seen, submitted } = harness({ ackFails: true });
  try {
    const running = worker.run();
    await new Promise((resolve) => setTimeout(resolve, 120));
    worker.stop();
    await running;
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(raised, []);
  assert.equal(submitted.length, 1, "후보는 이미 제출됐다");
  const warnings = seen.filter((status) => status.state === "warning");
  assert.ok(
    warnings.some((status) => /큐 정리 실패/u.test(status.message)),
    "정리 실패는 조용히 넘어가지 않고 알려져야 한다",
  );
});
