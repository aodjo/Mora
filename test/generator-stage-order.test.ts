import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "node:sqlite";
import { STAGE_JOB_UPDATE } from "../Server/src/admin/stage-state.js";

type Job = { state: string; current_stage: string | null; progress: number; error_code: string | null };

/**
 * A jobs table with one job in the given state, and a way to play stage events at it.
 *
 * @param {string} state - The job's state before any event arrives.
 * @returns {{ send: (next: string, stage: string, progress: number, code: string | null) => void, job: () => Job }}
 *   `send` applies one event the way the API does; `job` reads the row back.
 */
function jobIn(state: string): { send: (next: string, stage: string, progress: number, code: string | null) => void; job: () => Job } {
  const db = new Database.DatabaseSync(join(mkdtempSync(join(tmpdir(), "stage-")), "admin.sqlite"));
  db.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, current_stage TEXT NULL, progress REAL NOT NULL DEFAULT 0,
    error_code TEXT NULL, updated_at INTEGER NOT NULL)`);
  db.prepare("INSERT INTO jobs (id,state,current_stage,progress,error_code,updated_at) VALUES ('j1',?,NULL,0,NULL,0)").run(state);
  let clock = 1;
  return {
    send: (next, stage, progress, code) => {
      db.prepare(STAGE_JOB_UPDATE).run(next, stage, progress, code, clock++, "j1");
    },
    job: () => db.prepare("SELECT state,current_stage,progress,error_code FROM jobs WHERE id='j1'").get() as Job,
  };
}

test("a report that lands after the failure does not bring the job back to life", () => {
  // spark 에서 분리를 시작한 지 1초 만에 죽은 곡 — 「분리 시작」이 실패보다 늦게 닿았다.
  const { send, job } = jobIn("running");
  send("failed", "cleanup", 0, "ML_PIPELINE_FAILED");
  send("running", "separate", 0.2, null);
  assert.deepEqual({ ...job() }, { state: "failed", current_stage: "cleanup", progress: 0, error_code: "ML_PIPELINE_FAILED" });
});

test("stages in order still move a running job, and a later failure still lands", () => {
  const { send, job } = jobIn("running");
  send("running", "download", 0.03, null);
  send("running", "separate", 0.2, null);
  assert.equal(job().current_stage, "separate");
  send("failed", "cleanup", 0, "SEPARATION_FAILED");
  assert.deepEqual({ ...job() }, { state: "failed", current_stage: "cleanup", progress: 0, error_code: "SEPARATION_FAILED" });
});

test("a new attempt moves a job that failed before", () => {
  // 큐가 다시 잡으면 claimed 가 되고, 그 뒤의 단계는 평소대로 움직인다.
  const { send, job } = jobIn("claimed");
  send("running", "download", 0.03, null);
  assert.deepEqual({ ...job() }, { state: "running", current_stage: "download", progress: 0.03, error_code: null });
});

test("a settled job keeps its state but still shows its last step", () => {
  const { send, job } = jobIn("candidate_ready");
  send("running", "cleanup", 1, null);
  assert.deepEqual({ ...job() }, { state: "candidate_ready", current_stage: "cleanup", progress: 1, error_code: null });
});
