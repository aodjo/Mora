import assert from "node:assert/strict";
import test from "node:test";
import { GeneratorWorker } from "../Generator/src/worker.js";
import type { AdminClient } from "../Generator/src/admin-client.js";
import type { GeneratorQueue, LeasedMessage } from "../Generator/src/queue.js";
import type { MlDaemon } from "../Generator/src/ml-daemon.js";

/**
 * 놀고 있는 워커가 얼마나 자주 서버를 부르는가.
 *
 * 5 초마다 심장 소리 하나와 물음 하나를 보냈고, 그것만으로 워커 한 대가 하루 34,560 번이었다.
 * 세 대를 띄운 날 Cloudflare 무료 플랜의 하루 10 만 번을 아무 일도 하지 않고 넘겼고, Worker 가
 * 꺼지면서 관리 화면과 공개 API 가 자정까지 함께 멎었다.
 *
 * 여기서는 시계를 가짜로 돌려, 한 시간 동안 빈 큐를 지키는 워커가 몇 번 부르는지 센다.
 */
function idleWorker(): { worker: GeneratorWorker; calls: () => { beats: number; pulls: number } } {
  let beats = 0;
  let pulls = 0;
  const worker = new GeneratorWorker({
    workerId: "w1",
    version: "0.1.0",
    artifactPublicKey: "key",
    idleMs: 5_000,
    admin: {
      heartbeat: async () => {
        beats += 1;
        return { desired_state: "active" };
      },
    } as unknown as AdminClient,
    queue: {
      pull: async (): Promise<LeasedMessage | null> => {
        pulls += 1;
        return null;
      },
      ack: async () => undefined,
      retry: async () => undefined,
    } as unknown as GeneratorQueue,
    daemon: { run: async () => ({}), close: () => undefined } as unknown as MlDaemon,
  });
  return { worker, calls: () => ({ beats, pulls }) };
}

/** setTimeout 과 Date.now 를 갈아끼워 한 시간을 몇 밀리초에 지나가게 한다. */
async function overAnHour(worker: GeneratorWorker): Promise<void> {
  const realTimeout = globalThis.setTimeout;
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  // 기다림은 시계를 앞으로 돌리는 것으로 갈음하고, 실제로는 즉시 이어간다.
  (globalThis as unknown as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms?: number) => {
    clock += ms ?? 0;
    if (clock >= 1_000_000 + 3_600_000) worker.stop();
    return realTimeout(fn, 0);
  }) as unknown as typeof globalThis.setTimeout;
  try {
    await worker.run();
  } finally {
    globalThis.setTimeout = realTimeout;
    Date.now = realNow;
  }
}

test("an idle worker does not spend the day's request allowance doing nothing", async () => {
  const { worker, calls } = idleWorker();
  await overAnHour(worker);
  const { beats, pulls } = calls();

  // 예전 셈: 시간당 720 번씩 두 갈래, 하루 34,560 번.
  assert.ok(beats + pulls < 300, `한 시간에 ${beats + pulls}번 불렀다 — 너무 잦다`);
  // 심장 소리는 30 초에 한 번이 천장이므로 한 시간에 120 번을 넘지 않는다.
  assert.ok(beats <= 121, `심장 소리 ${beats}번`);
  // 물음은 1 분까지 물러나므로 한 시간에 70 번을 넘지 않는다.
  assert.ok(pulls <= 70, `물음 ${pulls}번`);

  // 세 대를 하루 종일 띄워도 무료 플랜 한도 안에 들어야 한다.
  const perDay = (beats + pulls) * 24 * 3;
  assert.ok(perDay < 100_000, `워커 세 대가 하루 ${perDay}번 — 한도를 넘는다`);
});

test("the first look after a job is still immediate", async () => {
  // 물러남은 연달아 비었을 때만이다. 한 곡을 끝내고 다음을 집는 속도는 그대로여야 한다.
  const { worker } = idleWorker();
  const realTimeout = globalThis.setTimeout;
  const realNow = Date.now;
  const waits: number[] = [];
  let clock = 0;
  Date.now = () => clock;
  (globalThis as unknown as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms?: number) => {
    waits.push(ms ?? 0);
    clock += ms ?? 0;
    if (waits.length >= 4) worker.stop();
    return realTimeout(fn, 0);
  }) as unknown as typeof globalThis.setTimeout;
  try {
    await worker.run();
  } finally {
    globalThis.setTimeout = realTimeout;
    Date.now = realNow;
  }
  assert.equal(waits[0], 5_000);
  assert.deepEqual(waits.slice(0, 4), [5_000, 10_000, 20_000, 40_000]);
});
