/**
 * How one stage event moves its job row.
 *
 * Stage reports leave the worker without waiting for one another, so they can reach the server out
 * of order. A pipeline that fails a second into separating sends "separate started" and then the
 * failure, and the first can land last. It walked the failed job back to running and wiped its
 * error code: on 2026-09-18 two songs on spark failed three times each in a second, yet the admin
 * page kept saying "음원 분리 — 몇 분째 소식이 없습니다", and the queue refused the worker's ack
 * because a running job is not finished.
 *
 * A settled job keeps its state. A failed job also keeps where and why it failed; only another
 * failure, or a new attempt (the claim sets `claimed`), moves it. Every value on the right-hand
 * side reads the row as it was before this update.
 *
 * Binds: ?1 next state (`running`, `failed` or `unsupported_language`) · ?2 stage · ?3 progress ·
 * ?4 error code · ?5 now · ?6 job id.
 *
 * @example
 * await env.ADMIN_DB.prepare(STAGE_JOB_UPDATE).bind("running", "separate", 0.2, null, Date.now(), jobId).run();
 */
export const STAGE_JOB_UPDATE = `UPDATE jobs SET
  state=CASE WHEN state IN ('candidate_ready','published','cancelled','unsupported_language') OR (state='failed' AND ?1='running') THEN state ELSE ?1 END,
  current_stage=CASE WHEN state='failed' AND ?1='running' THEN current_stage ELSE ?2 END,
  progress=CASE WHEN state='failed' AND ?1='running' THEN progress ELSE ?3 END,
  error_code=CASE WHEN state='failed' AND ?1='running' THEN error_code ELSE ?4 END,
  updated_at=?5
  WHERE id=?6`;
