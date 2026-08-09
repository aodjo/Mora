import { preprocessLyrics } from "../../../packages/preprocess/src/index.js";
import { textHash } from "../../../packages/core/src/tokenization/fingerprint.js";
import { tokenizeV2 } from "../../../packages/core/src/tokenization/tokenizer-v2.js";
import { ServiceError } from "../../../packages/core/src/shared/errors.js";
import type {
  GeneratorCandidateSubmission,
  GeneratorJobInput,
  StageEvent,
  WorkerCapabilities,
} from "../../../packages/contracts/src/index.js";
import { JOB_SCHEMA_VERSION } from "../../../packages/contracts/src/index.js";
import type { WorkerEnv } from "../env.js";
import { audit, authenticate, requirePermission, sha256, type Actor } from "./auth.js";
import { publishAdminEvent } from "./events.js";
import { bootstrapOptions, bootstrapVerify, credentialOptions, credentialVerify, loginOptions, loginVerify, logout } from "./webauthn.js";
import { serveArtifact } from "./artifacts.js";
import { approveCollectorPairing, pollCollectorPairing, startCollectorPairing } from "./collector-pairing.js";
import { approveGeneratorPairing, pollGeneratorPairing, startGeneratorPairing } from "./generator-pairing.js";
import {
  collectorRuntimeConfig,
  deleteRuntimeConfig,
  listRuntimeConfig,
  putRuntimeConfig,
  runtimeValue,
  webhookSignature,
} from "./runtime-config.js";
import { openSecret, sealSecret } from "./secrets.js";
import { normalizeIsrc, resolveLyricLanguage, youtubeVideoId } from "./source-review.js";
import { buildReviewLyrics } from "./candidate-review.js";

const jsonHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
} as const;
// Human approvals required before the quality gate is allowed to promote on its own.
const CALIBRATION_TARGET = 100;
// How long a claimed job may go without a stage event before the queue treats it as abandoned.
// Generous on purpose: separation is the longest stage and reports nothing while it runs.
const WORKER_LEASE_MS = 30 * 60_000;
const WORKER_STATES = ["active", "draining", "paused", "update"] as const;

function json(value: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...jsonHeaders, ...Object.fromEntries(new Headers(extra)) } });
}

async function body(request: Request, max = 2 * 1024 * 1024): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > max) throw new ServiceError(413, "PAYLOAD_TOO_LARGE");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > max) throw new ServiceError(413, "PAYLOAD_TOO_LARGE");
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ServiceError(400, "BAD_JSON");
  }
}

function requiredString(value: unknown, max = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new ServiceError(400, "INVALID_REQUEST");
  return value;
}

function numberValue(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new ServiceError(400, "INVALID_REQUEST");
  return value;
}

function encode(value: unknown): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(value)).buffer;
}

function decode<T>(value: ArrayBuffer | number[]): T {
  return JSON.parse(new TextDecoder().decode(Array.isArray(value) ? Uint8Array.from(value) : new Uint8Array(value))) as T;
}

function randomSecret(): string {
  const data = crypto.getRandomValues(new Uint8Array(32));
  return `mora_${Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function event(env: WorkerEnv, type: string, data: Record<string, unknown>): Promise<void> {
  await publishAdminEvent(env.ADMIN_EVENTS, { type, data, at: Date.now() });
  await dispatchNotifications(env, type, data);
}

function actorJson(actor: Actor): unknown {
  return { type: actor.type, id: actor.id, permissions: [...actor.permissions].sort() };
}

async function overview(env: WorkerEnv): Promise<unknown> {
  const [jobs, workers, candidates, recordings, releases, settings] = await Promise.all([
    env.ADMIN_DB.prepare("SELECT state, COUNT(*) count FROM jobs GROUP BY state").all<{ state: string; count: number }>(),
    env.ADMIN_DB.prepare(
      "SELECT COUNT(*) total, SUM(CASE WHEN production_ready=1 AND desired_state='active' AND last_seen_at>?1 THEN 1 ELSE 0 END) healthy FROM workers",
    )
      .bind(Date.now() - 120_000)
      .first<{ total: number; healthy: number }>(),
    env.ADMIN_DB.prepare("SELECT COUNT(*) count FROM alignment_candidates WHERE status='pending'").first<{ count: number }>(),
    env.ADMIN_DB.prepare("SELECT COUNT(*) count FROM recordings").first<{ count: number }>(),
    env.ADMIN_DB.prepare("SELECT COUNT(*) count FROM releases WHERE state='active'").first<{ count: number }>(),
    env.ADMIN_DB.prepare("SELECT key,value FROM settings WHERE key IN ('calibration_reviews','auto_promotion_enabled')").all<{
      key: string;
      value: string;
    }>(),
  ]);
  const values = Object.fromEntries(settings.results.map((row) => [row.key, row.value]));
  return {
    jobs: Object.fromEntries(jobs.results.map((row) => [row.state, row.count])),
    workers: workers ?? { total: 0, healthy: 0 },
    review_count: candidates?.count ?? 0,
    recording_count: recordings?.count ?? 0,
    release_count: releases?.count ?? 0,
    calibration: {
      reviews: Number(values.calibration_reviews ?? 0),
      target: CALIBRATION_TARGET,
      auto_promotion_enabled: values.auto_promotion_enabled === "true",
    },
  };
}

async function list(database: D1Database, sql: string, bindings: unknown[] = []): Promise<unknown[]> {
  const result = await database
    .prepare(sql)
    .bind(...bindings)
    .all<Record<string, unknown>>();
  return result.results;
}

async function createServiceKey(env: WorkerEnv, actor: Actor, value: Record<string, unknown>): Promise<Response> {
  requirePermission(actor, "service_keys.manage");
  const name = requiredString(value.name, 100);
  const scopes = value.scopes;
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string")) throw new ServiceError(400, "INVALID_REQUEST");
  const secret = randomSecret();
  const id = crypto.randomUUID();
  await env.ADMIN_DB.prepare("INSERT INTO service_keys (id, name, prefix, secret_hash, scopes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(id, name, secret.slice(0, 13), await sha256(secret), JSON.stringify(scopes), Date.now())
    .run();
  await audit(env, actor, "service_key.create", "service_key", id, { name, scopes });
  return json({ id, secret, prefix: secret.slice(0, 13), scopes }, 201);
}

async function upsertRole(env: WorkerEnv, actor: Actor, value: Record<string, unknown>): Promise<Response> {
  requirePermission(actor, "roles.manage");
  const permissions = value.permissions;
  if (!Array.isArray(permissions) || permissions.some((item) => typeof item !== "string")) throw new ServiceError(400, "INVALID_REQUEST");
  const id = typeof value.id === "string" ? value.id : crypto.randomUUID();
  await env.ADMIN_DB.prepare(
    "INSERT INTO roles (id,name,permissions,created_at) VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET name=excluded.name,permissions=excluded.permissions",
  )
    .bind(id, requiredString(value.name, 100), JSON.stringify(permissions), Date.now())
    .run();
  await audit(env, actor, "role.upsert", "role", id, { permissions });
  return json({ id }, 201);
}
async function assignRole(env: WorkerEnv, actor: Actor, userId: string, value: Record<string, unknown>): Promise<Response> {
  requirePermission(actor, "roles.manage");
  const roleId = requiredString(value.role_id, 100);
  await env.ADMIN_DB.prepare("INSERT OR IGNORE INTO user_roles (user_id,role_id) VALUES (?1,?2)").bind(userId, roleId).run();
  await audit(env, actor, "user.role.assign", "user", userId, { role_id: roleId });
  return json({ user_id: userId, role_id: roleId });
}
async function unassignRole(env: WorkerEnv, actor: Actor, userId: string, roleId: string): Promise<Response> {
  requirePermission(actor, "roles.manage");
  await env.ADMIN_DB.prepare("DELETE FROM user_roles WHERE user_id=?1 AND role_id=?2").bind(userId, roleId).run();
  await audit(env, actor, "user.role.unassign", "user", userId, { role_id: roleId });
  return json({ user_id: userId, role_id: roleId });
}
async function addNotification(env: WorkerEnv, actor: Actor, value: Record<string, unknown>): Promise<Response> {
  requirePermission(actor, "notifications.manage");
  const kind = requiredString(value.kind, 20);
  if (kind !== "webhook" && kind !== "discord") throw new ServiceError(400, "INVALID_REQUEST");
  const targetUrl = requiredString(value.url, 4096);
  const parsed = new URL(targetUrl);
  if (parsed.protocol !== "https:") throw new ServiceError(400, "INVALID_REQUEST");
  const id = crypto.randomUUID();
  const events = Array.isArray(value.events) ? value.events.filter((item) => typeof item === "string") : [];
  await env.ADMIN_DB.prepare("INSERT INTO notification_targets (id,kind,name,url_ciphertext,events,created_at) VALUES (?1,?2,?3,?4,?5,?6)")
    .bind(id, kind, requiredString(value.name, 100), await sealSecret(env, targetUrl), JSON.stringify(events), Date.now())
    .run();
  await audit(env, actor, "notification.create", "notification", id, { kind, events });
  return json({ id, kind, configured: true }, 201);
}

async function revokeServiceKey(env: WorkerEnv, actor: Actor, keyId: string): Promise<Response> {
  requirePermission(actor, "service_keys.manage");
  if (actor.type === "service" && actor.id === keyId) throw new ServiceError(409, "CONFLICT");
  const revoked = await env.ADMIN_DB.prepare("UPDATE service_keys SET revoked_at=?1 WHERE id=?2 AND revoked_at IS NULL")
    .bind(Date.now(), keyId)
    .run();
  if ((revoked.meta.changes ?? 0) !== 1) throw new ServiceError(404, "NOT_FOUND");
  await audit(env, actor, "service_key.revoke", "service_key", keyId);
  return json({ id: keyId, revoked: true });
}

async function createEnrollment(env: WorkerEnv, actor: Actor): Promise<Response> {
  requirePermission(actor, "workers.manage");
  const token = randomSecret();
  await env.ADMIN_DB.prepare("INSERT INTO enrollment_tokens (token_hash, expires_at, created_by, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(await sha256(token), Date.now() + 10 * 60_000, actor.id, Date.now())
    .run();
  await audit(env, actor, "worker.enrollment.create", "worker", null);
  return json({ token, expires_at: Date.now() + 10 * 60_000 }, 201);
}

async function enrollWorker(env: WorkerEnv, value: Record<string, unknown>): Promise<Response> {
  const token = requiredString(value.token);
  const capabilities = value.capabilities as WorkerCapabilities | undefined;
  if (capabilities === undefined || typeof capabilities !== "object") throw new ServiceError(400, "INVALID_REQUEST");
  const enrollment = await env.ADMIN_DB.prepare(
    "SELECT token_hash FROM enrollment_tokens WHERE token_hash=?1 AND used_at IS NULL AND expires_at>?2",
  )
    .bind(await sha256(token), Date.now())
    .first<{ token_hash: string }>();
  if (enrollment === null) throw new ServiceError(401, "UNAUTHORIZED");
  const workerId = capabilities.worker_id || crypto.randomUUID();
  const apiKey = randomSecret();
  const keyId = crypto.randomUUID();
  await env.ADMIN_DB.batch([
    env.ADMIN_DB.prepare("UPDATE enrollment_tokens SET used_at=?1 WHERE token_hash=?2").bind(Date.now(), enrollment.token_hash),
    env.ADMIN_DB.prepare(
      `INSERT INTO workers (id,name,version,backend,hardware,capabilities,self_test,production_ready,last_seen_at,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)`,
    ).bind(
      workerId,
      requiredString(value.name ?? workerId, 100),
      capabilities.version,
      capabilities.backend,
      capabilities.hardware,
      JSON.stringify(capabilities.capabilities),
      JSON.stringify(capabilities.self_test),
      capabilities.production_ready ? 1 : 0,
      Date.now(),
    ),
    env.ADMIN_DB.prepare("INSERT INTO service_keys (id,name,prefix,secret_hash,scopes,created_at) VALUES (?1,?2,?3,?4,?5,?6)").bind(
      keyId,
      `worker:${workerId}`,
      apiKey.slice(0, 13),
      await sha256(apiKey),
      JSON.stringify([
        "generator.jobs.read",
        "generator.events.write",
        "generator.candidates.write",
        "generator.artifacts.write",
        "workers.heartbeat",
      ]),
      Date.now(),
    ),
  ]);
  await audit(env, null, "worker.enroll", "worker", workerId, {
    backend: capabilities.backend,
    production_ready: capabilities.production_ready,
  });
  return json({ worker_id: workerId, api_key: apiKey }, 201);
}

/** What is still missing before a job can open, so the collector can say why it stopped. */
function blockedBy(isrc: string | null, sourceId: string | null): string[] {
  return [...(isrc === null ? ["isrc"] : []), ...(sourceId === null ? ["source"] : [])];
}

/**
 * Everything the catalogue already holds, so a run can skip it before spending anything.
 * A song costs a YouTube search, five lyrics providers and a Spotify lookup to collect, and
 * re-submitting one only lands another input revision beside the identical one already there.
 */
async function collectorCollected(env: WorkerEnv, actor: Actor): Promise<Response> {
  requirePermission(actor, "collector.submit");
  const { results } = await env.ADMIN_DB.prepare("SELECT artist,title,isrc FROM recordings").all<{
    artist: string;
    title: string;
    isrc: string | null;
  }>();
  return json({
    recordings: results.map((row) => ({
      artist: row.artist,
      title: row.title,
      ...(row.isrc === null ? {} : { isrc: row.isrc }),
    })),
  });
}

async function collectorSubmit(env: WorkerEnv, actor: Actor, value: Record<string, unknown>): Promise<Response> {
  requirePermission(actor, "collector.submit");
  const recordingValue = value.recording;
  if (typeof recordingValue !== "object" || recordingValue === null || Array.isArray(recordingValue))
    throw new ServiceError(400, "INVALID_REQUEST");
  const recording = recordingValue as Record<string, unknown>;
  const isrc = typeof recording.isrc === "string" && recording.isrc.length > 0 ? recording.isrc.replaceAll("-", "").toUpperCase() : null;
  const mbid = typeof recording.mbid === "string" && recording.mbid.length > 0 ? recording.mbid : null;
  const recordingId = crypto.randomUUID();
  const now = Date.now();
  let existing =
    isrc === null
      ? null
      : await env.ADMIN_DB.prepare("SELECT id,isrc FROM recordings WHERE isrc=?1 LIMIT 1")
          .bind(isrc)
          .first<{ id: string; isrc: string | null }>();
  if (existing === null && mbid !== null)
    existing = await env.ADMIN_DB.prepare("SELECT id,isrc FROM recordings WHERE mbid=?1 LIMIT 1")
      .bind(mbid)
      .first<{ id: string; isrc: string | null }>();
  const targetRecordingId = existing?.id ?? recordingId;
  if (existing === null) {
    if (
      typeof recording.duration_ms !== "number" ||
      !Number.isFinite(recording.duration_ms) ||
      recording.duration_ms < 1 ||
      recording.duration_ms > 900_000
    )
      throw new ServiceError(400, "DURATION_REQUIRED");
    await env.ADMIN_DB.prepare(
      `INSERT INTO recordings (id,isrc,mbid,artist,title,album,duration_ms,language,identification_state,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)`,
    )
      .bind(
        targetRecordingId,
        isrc,
        mbid,
        requiredString(recording.artist, 500),
        requiredString(recording.title, 500),
        typeof recording.album === "string" ? recording.album : null,
        numberValue(recording.duration_ms, 1, 900_000),
        typeof recording.language === "string" ? recording.language : "und",
        isrc === null ? "pending" : "verified",
        now,
      )
      .run();
  } else {
    await env.ADMIN_DB.prepare(
      "UPDATE recordings SET isrc=COALESCE(isrc,?1),mbid=COALESCE(mbid,?2),artist=?3,title=?4,album=COALESCE(?5,album),duration_ms=?6,language=CASE WHEN ?7='und' THEN language ELSE ?7 END,identification_state=CASE WHEN COALESCE(isrc,?1) IS NULL THEN identification_state ELSE 'verified' END,updated_at=?8 WHERE id=?9",
    )
      .bind(
        isrc,
        mbid,
        requiredString(recording.artist, 500),
        requiredString(recording.title, 500),
        typeof recording.album === "string" ? recording.album : null,
        numberValue(recording.duration_ms, 1, 900_000),
        typeof recording.language === "string" ? recording.language : "und",
        now,
        targetRecordingId,
      )
      .run();
  }

  const sources = Array.isArray(value.sources) ? value.sources : [];
  let selectedSourceId: string | null = null;
  let selectedVideoId: string | null = null;
  for (const source of sources) {
    if (typeof source !== "object" || source === null || Array.isArray(source)) continue;
    const item = source as Record<string, unknown>;
    const id = crypto.randomUUID();
    const selected = item.selected === true && item.source_type !== "video";
    if (selected) selectedVideoId = requiredString(item.video_id, 32);
    await env.ADMIN_DB.prepare(
      `INSERT OR IGNORE INTO media_sources (id,recording_id,url,video_id,rank,official,source_type,score,selected,metadata,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
    )
      .bind(
        id,
        targetRecordingId,
        requiredString(item.url),
        requiredString(item.video_id, 32),
        numberValue(item.rank ?? 1, 1, 10),
        item.official === true ? 1 : 0,
        item.official === true ? "topic" : "unofficial",
        numberValue(item.score ?? 0, 0, 1),
        selected ? 1 : 0,
        JSON.stringify(item.metadata ?? {}),
        now,
      )
      .run();
    const stored = await env.ADMIN_DB.prepare("SELECT id FROM media_sources WHERE recording_id=?1 AND video_id=?2")
      .bind(targetRecordingId, item.video_id)
      .first<{ id: string }>();
    if (selected && stored !== null) {
      selectedSourceId = stored.id;
      await env.ADMIN_DB.prepare("UPDATE media_sources SET selected=CASE WHEN id=?1 THEN 1 ELSE 0 END WHERE recording_id=?2")
        .bind(stored.id, targetRecordingId)
        .run();
    }
  }
  if (selectedSourceId === null) {
    const selected = await env.ADMIN_DB.prepare(
      "SELECT id,video_id FROM media_sources WHERE recording_id=?1 AND selected=1 ORDER BY score DESC LIMIT 1",
    )
      .bind(targetRecordingId)
      .first<{ id: string; video_id: string }>();
    selectedSourceId = selected?.id ?? null;
    selectedVideoId = selected?.video_id ?? null;
  }

  const lyrics = Array.isArray(value.lyrics) ? value.lyrics : [];
  const signatureParts = await Promise.all(
    lyrics.flatMap((item) =>
      typeof item === "object" && item !== null && !Array.isArray(item)
        ? [sha256(`${String((item as Record<string, unknown>).provider ?? "")}\0${String((item as Record<string, unknown>).text ?? "")}`)]
        : [],
    ),
  );
  const inputSignature = await sha256(`${selectedVideoId ?? "none"}\0production-v1\0${signatureParts.sort().join("\0")}`);
  const duplicate = await env.ADMIN_DB.prepare(
    "SELECT i.id,i.source_id,j.id job_id,j.state FROM input_revisions i LEFT JOIN jobs j ON j.input_revision_id=i.id WHERE i.recording_id=?1 AND i.input_signature=?2",
  )
    .bind(targetRecordingId, inputSignature)
    .first<{ id: string; source_id: string | null; job_id: string | null; state: string | null }>();
  if (duplicate !== null) {
    await audit(env, actor, "collector.duplicate", "input_revision", duplicate.id);
    return json({
      recording_id: targetRecordingId,
      input_revision_id: duplicate.id,
      job_id: duplicate.job_id,
      state: duplicate.state ?? "review_required",
      ...(duplicate.job_id === null ? { blocked_by: blockedBy(isrc, duplicate.source_id) } : {}),
      deduplicated: true,
    });
  }
  const inputId = crypto.randomUUID();
  await env.ADMIN_DB.prepare(
    "INSERT INTO input_revisions (id,recording_id,source_id,state,pipeline_profile,created_by,created_at,input_signature) VALUES (?1,?2,?3,?4,'production-v1',?5,?6,?7)",
  )
    .bind(
      inputId,
      targetRecordingId,
      selectedSourceId,
      isrc !== null && selectedSourceId !== null ? "ready" : "draft",
      actor.id,
      now,
      inputSignature,
    )
    .run();
  for (const lyric of lyrics) {
    if (typeof lyric !== "object" || lyric === null || Array.isArray(lyric)) continue;
    const item = lyric as Record<string, unknown>;
    const raw = requiredString(item.text, 1_000_000);
    const provider = requiredString(item.provider, 100);
    const language =
      typeof item.language === "string" ? item.language : typeof recording.language === "string" ? recording.language : "und";
    const rawHash = await sha256(raw);
    await env.ADMIN_DB.prepare(
      `INSERT OR IGNORE INTO lyric_revisions (id,input_revision_id,provider,provider_ref,layer,language,text,text_hash,preprocessor,confidence,review_required,offset_map,rules,created_at) VALUES (?1,?2,?3,?4,'raw',?5,?6,?7,'raw-v1',1,0,'[]','[]',?8)`,
    )
      .bind(
        crypto.randomUUID(),
        inputId,
        provider,
        typeof item.provider_ref === "string" ? item.provider_ref : null,
        language,
        raw,
        rawHash,
        now,
      )
      .run();
    const processed = preprocessLyrics(raw, language);
    for (const variant of processed.variants) {
      const tokenization = tokenizeV2(variant.text, variant.language);
      if (tokenization.tokens.length === 0) continue;
      await env.ADMIN_DB.prepare(
        `INSERT OR IGNORE INTO lyric_revisions (id,input_revision_id,provider,provider_ref,layer,language,text,text_hash,preprocessor,confidence,review_required,offset_map,rules,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`,
      )
        .bind(
          crypto.randomUUID(),
          inputId,
          provider,
          typeof item.provider_ref === "string" ? item.provider_ref : null,
          variant.layer,
          variant.language,
          variant.text,
          textHash(tokenization.canonical),
          processed.version,
          variant.confidence,
          variant.review_required ? 1 : 0,
          JSON.stringify(variant.offset_map),
          JSON.stringify(variant.rules),
          now,
        )
        .run();
    }
  }

  let jobId: string | null = null;
  if (isrc !== null && selectedSourceId !== null) {
    jobId = crypto.randomUUID();
    await env.ADMIN_DB.prepare(
      "INSERT INTO jobs (id,input_revision_id,state,priority,available_at,created_at,updated_at) VALUES (?1,?2,'queued',?3,?4,?4,?4)",
    )
      .bind(jobId, inputId, numberValue(value.priority ?? 0, -1_000_000, 1_000_000), now)
      .run();
  }
  await audit(env, actor, "collector.submit", "input_revision", inputId, {
    recording_id: targetRecordingId,
    job_id: jobId,
    lyric_count: lyrics.length,
  });
  await event(env, "collector.submitted", { recording_id: targetRecordingId, input_revision_id: inputId, job_id: jobId });
  return json(
    {
      recording_id: targetRecordingId,
      input_revision_id: inputId,
      job_id: jobId,
      state: jobId === null ? "review_required" : "queued",
      ...(jobId === null ? { blocked_by: blockedBy(isrc, selectedSourceId) } : {}),
    },
    201,
  );
}

interface SourceReviewItem {
  input_revision_id: string;
  recording_id: string;
  artist: string;
  title: string;
  album: string | null;
  isrc: string | null;
  duration_ms: number;
  language: string;
  created_at: number;
  lyrics_count: number;
  sources: Array<{
    id: string;
    url: string;
    video_id: string;
    rank: number;
    official: boolean;
    source_type: string;
    score: number;
    metadata: Record<string, unknown>;
  }>;
}

async function reviewQueues(env: WorkerEnv, actor: Actor): Promise<Response> {
  requirePermission(actor, "recordings.read");
  requirePermission(actor, "candidates.read");
  const [rows, candidates] = await Promise.all([
    env.ADMIN_DB.prepare(
      `SELECT i.id input_revision_id,i.created_at,r.id recording_id,r.artist,r.title,r.album,r.isrc,r.duration_ms,r.language,
      (SELECT COUNT(*) FROM lyric_revisions l WHERE l.input_revision_id=i.id AND l.layer!='raw') lyrics_count,
      s.id source_id,s.url,s.video_id,s.rank,s.official,s.source_type,s.score,s.metadata
      FROM input_revisions i JOIN recordings r ON r.id=i.recording_id LEFT JOIN media_sources s ON s.recording_id=r.id
      WHERE i.state='draft' AND i.source_id IS NULL AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.input_revision_id=i.id)
      ORDER BY CASE WHEN s.id IS NULL THEN 1 ELSE 0 END,i.created_at DESC,s.rank LIMIT 1000`,
    ).all<Record<string, unknown>>(),
    env.ADMIN_DB.prepare(
      `SELECT c.id,c.job_id,c.input_revision_id,c.variant_id,c.status,c.tokenizer,c.quality,c.quality_score,c.created_at,
        r.artist,r.title,l.provider,l.language
       FROM alignment_candidates c
       JOIN input_revisions i ON i.id=c.input_revision_id
       JOIN recordings r ON r.id=i.recording_id
       JOIN lyric_revisions l ON l.id=c.variant_id
       ORDER BY c.created_at DESC LIMIT 200`,
    ).all<Record<string, unknown>>(),
  ]);
  const grouped = new Map<string, SourceReviewItem>();
  for (const row of rows.results) {
    const inputId = String(row.input_revision_id);
    let item = grouped.get(inputId);
    if (item === undefined) {
      item = {
        input_revision_id: inputId,
        recording_id: String(row.recording_id),
        artist: String(row.artist),
        title: String(row.title),
        album: typeof row.album === "string" ? row.album : null,
        isrc: typeof row.isrc === "string" ? row.isrc : null,
        duration_ms: Number(row.duration_ms),
        language: String(row.language),
        created_at: Number(row.created_at),
        lyrics_count: Number(row.lyrics_count),
        sources: [],
      };
      grouped.set(inputId, item);
    }
    if (typeof row.source_id === "string")
      item.sources.push({
        id: row.source_id,
        url: String(row.url),
        video_id: String(row.video_id),
        rank: Number(row.rank),
        official: row.official === 1,
        source_type: String(row.source_type),
        score: Number(row.score),
        metadata: typeof row.metadata === "string" ? (JSON.parse(row.metadata) as Record<string, unknown>) : {},
      });
  }
  return json({ source_items: [...grouped.values()], candidate_items: candidates.results });
}

async function updateSourceReview(env: WorkerEnv, actor: Actor, inputId: string, value: Record<string, unknown>): Promise<Response> {
  requirePermission(actor, "jobs.manage");
  const input = await env.ADMIN_DB.prepare(
    `SELECT i.id,i.recording_id,i.state,r.isrc,r.language,(SELECT COUNT(*) FROM lyric_revisions l WHERE l.input_revision_id=i.id AND l.layer!='raw') lyrics_count FROM input_revisions i JOIN recordings r ON r.id=i.recording_id WHERE i.id=?1`,
  )
    .bind(inputId)
    .first<{ id: string; recording_id: string; state: string; isrc: string | null; language: string; lyrics_count: number }>();
  if (input === null) throw new ServiceError(404, "NOT_FOUND");
  if (input.state !== "draft") throw new ServiceError(409, "CONFLICT");
  const suppliedIsrc = typeof value.isrc === "string" ? value.isrc : "";
  const isrc = normalizeIsrc(suppliedIsrc || (input.isrc ?? ""));
  const duplicate = await env.ADMIN_DB.prepare("SELECT id FROM recordings WHERE isrc=?1 AND id!=?2")
    .bind(isrc, input.recording_id)
    .first<{ id: string }>();
  if (duplicate !== null) throw new ServiceError(409, "CONFLICT");
  const raw = typeof value.lyrics === "string" ? value.lyrics.trim() : "";
  if (input.lyrics_count < 1 && raw.length === 0) throw new ServiceError(400, "INVALID_REQUEST");
  const requestedLanguage = typeof value.language === "string" ? value.language : input.language;
  const language =
    raw.length > 0
      ? resolveLyricLanguage(requestedLanguage, raw)
      : ["ko", "en", "ja"].includes(requestedLanguage)
        ? requestedLanguage
        : input.language;
  await env.ADMIN_DB.batch([
    env.ADMIN_DB.prepare("UPDATE recordings SET isrc=?1,language=?2,identification_state='verified',updated_at=?3 WHERE id=?4").bind(
      isrc,
      language,
      Date.now(),
      input.recording_id,
    ),
    env.ADMIN_DB.prepare("UPDATE input_revisions SET input_signature=NULL WHERE id=?1").bind(inputId),
  ]);
  if (raw.length > 0) {
    const now = Date.now();
    const provider = "manual-admin";
    const rawHash = await sha256(raw);
    await env.ADMIN_DB.prepare(
      `INSERT OR IGNORE INTO lyric_revisions (id,input_revision_id,provider,provider_ref,layer,language,text,text_hash,preprocessor,confidence,review_required,offset_map,rules,created_at) VALUES (?1,?2,?3,NULL,'raw',?4,?5,?6,'raw-v1',1,0,'[]','[]',?7)`,
    )
      .bind(crypto.randomUUID(), inputId, provider, language, raw, rawHash, now)
      .run();
    const processed = preprocessLyrics(raw, language);
    for (const variant of processed.variants) {
      const tokenization = tokenizeV2(variant.text, variant.language);
      if (tokenization.tokens.length === 0) continue;
      await env.ADMIN_DB.prepare(
        `INSERT OR IGNORE INTO lyric_revisions (id,input_revision_id,provider,provider_ref,layer,language,text,text_hash,preprocessor,confidence,review_required,offset_map,rules,created_at) VALUES (?1,?2,?3,NULL,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`,
      )
        .bind(
          crypto.randomUUID(),
          inputId,
          provider,
          variant.layer,
          variant.language,
          variant.text,
          textHash(tokenization.canonical),
          processed.version,
          variant.confidence,
          variant.review_required ? 1 : 0,
          JSON.stringify(variant.offset_map),
          JSON.stringify(variant.rules),
          now,
        )
        .run();
    }
  }
  await audit(env, actor, "source.metadata_update", "input_revision", inputId, {
    recording_id: input.recording_id,
    isrc_updated: suppliedIsrc.trim().length > 0,
    lyrics_added: raw.length > 0,
    language,
  });
  await event(env, "collector.metadata_updated", { input_revision_id: inputId });
  return json({ input_revision_id: inputId, ready_for_source: true });
}

async function selectSourceReview(env: WorkerEnv, actor: Actor, inputId: string, value: Record<string, unknown>): Promise<Response> {
  requirePermission(actor, "jobs.manage");
  const input = await env.ADMIN_DB.prepare(
    `SELECT i.id,i.recording_id,i.state,r.isrc,(SELECT COUNT(*) FROM lyric_revisions l WHERE l.input_revision_id=i.id AND l.layer!='raw') lyrics_count FROM input_revisions i JOIN recordings r ON r.id=i.recording_id WHERE i.id=?1`,
  )
    .bind(inputId)
    .first<{ id: string; recording_id: string; state: string; isrc: string | null; lyrics_count: number }>();
  if (input === null) throw new ServiceError(404, "NOT_FOUND");
  if (input.state !== "draft") throw new ServiceError(409, "CONFLICT");
  if (input.isrc === null || input.lyrics_count < 1) throw new ServiceError(409, "AMBIGUOUS_RECORDING");
  let sourceId = typeof value.source_id === "string" ? value.source_id : null;
  if (sourceId === null) {
    const url = requiredString(value.url, 4096);
    const videoId = youtubeVideoId(url);
    const existing = await env.ADMIN_DB.prepare("SELECT id FROM media_sources WHERE recording_id=?1 AND video_id=?2")
      .bind(input.recording_id, videoId)
      .first<{ id: string }>();
    sourceId = existing?.id ?? crypto.randomUUID();
    if (existing === null)
      await env.ADMIN_DB.prepare(
        `INSERT INTO media_sources (id,recording_id,url,video_id,rank,official,source_type,score,selected,metadata,created_at) VALUES (?1,?2,?3,?4,1,0,'unofficial',1,0,?5,?6)`,
      )
        .bind(sourceId, input.recording_id, url, videoId, JSON.stringify({ manual: true, created_by: actor.id }), Date.now())
        .run();
  }
  const source = await env.ADMIN_DB.prepare("SELECT id FROM media_sources WHERE id=?1 AND recording_id=?2")
    .bind(sourceId, input.recording_id)
    .first<{ id: string }>();
  if (source === null) throw new ServiceError(404, "NOT_FOUND");
  const existingJob = await env.ADMIN_DB.prepare("SELECT id,state FROM jobs WHERE input_revision_id=?1")
    .bind(inputId)
    .first<{ id: string; state: string }>();
  if (existingJob !== null) return json({ job_id: existingJob.id, state: existingJob.state, deduplicated: true });
  const jobId = crypto.randomUUID();
  const now = Date.now();
  await env.ADMIN_DB.batch([
    env.ADMIN_DB.prepare("UPDATE media_sources SET selected=CASE WHEN id=?1 THEN 1 ELSE 0 END WHERE recording_id=?2").bind(
      sourceId,
      input.recording_id,
    ),
    env.ADMIN_DB.prepare("UPDATE input_revisions SET source_id=?1,state='ready' WHERE id=?2 AND state='draft'").bind(sourceId, inputId),
    env.ADMIN_DB.prepare(
      "INSERT INTO jobs (id,input_revision_id,state,priority,available_at,created_at,updated_at) VALUES (?1,?2,'queued',0,?3,?3,?3)",
    ).bind(jobId, inputId, now),
  ]);
  await audit(env, actor, "source.approve", "input_revision", inputId, { source_id: sourceId, job_id: jobId });
  await event(env, "collector.source_approved", { input_revision_id: inputId, job_id: jobId });
  return json({ job_id: jobId, state: "queued" }, 201);
}

async function generatorActorWorker(
  env: WorkerEnv,
  actor: Actor,
): Promise<{ id: string; production_ready: number; desired_state: string }> {
  if (actor.type !== "service") throw new ServiceError(403, "FORBIDDEN");
  const worker = await env.ADMIN_DB.prepare(
    `
    SELECT w.id,w.production_ready,w.desired_state
    FROM service_keys k JOIN workers w ON k.name='worker:' || w.id
    WHERE k.id=?1 AND k.revoked_at IS NULL
  `,
  )
    .bind(actor.id)
    .first<{ id: string; production_ready: number; desired_state: string }>();
  if (worker === null) throw new ServiceError(403, "FORBIDDEN");
  return worker;
}

/**
 * A generator key proves which worker is calling, not which job it may touch. Without this the
 * job id in the body is taken on trust, and one paired device could fail, fabricate candidates
 * for, or attach artifacts to work it never claimed.
 */
async function requireOwnedJob(env: WorkerEnv, actor: Actor, jobId: string): Promise<void> {
  const worker = await generatorActorWorker(env, actor);
  const job = await env.ADMIN_DB.prepare("SELECT worker_id FROM jobs WHERE id=?1").bind(jobId).first<{ worker_id: string | null }>();
  if (job === null || job.worker_id !== worker.id) throw new ServiceError(409, "CONFLICT");
}

async function generatorQueuePull(env: WorkerEnv, actor: Actor): Promise<Response> {
  requirePermission(actor, "generator.jobs.read");
  const worker = await generatorActorWorker(env, actor);
  if (worker.production_ready !== 1 || worker.desired_state !== "active") throw new ServiceError(409, "CONFLICT");
  const now = Date.now();
  // A worker that dies mid-pipeline leaves its job claimed or running forever, and the queue
  // only ever looked at queued and failed. A live worker touches updated_at at every stage, so
  // going quiet for longer than the longest stage means the job is abandoned, not slow.
  const stale = now - WORKER_LEASE_MS;
  const claimable = `(state IN ('queued','failed') OR (state IN ('claimed','running') AND updated_at < ?4))
      AND cancel_requested=0 AND available_at<=?2 AND attempt_count<max_attempts`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const job = await env.ADMIN_DB.prepare(
      `
      SELECT id,input_revision_id,attempt_count
      FROM jobs
      WHERE (state IN ('queued','failed') OR (state IN ('claimed','running') AND updated_at < ?2))
        AND cancel_requested=0 AND available_at<=?1 AND attempt_count<max_attempts
      ORDER BY priority DESC,available_at ASC,created_at ASC LIMIT 1
    `,
    )
      .bind(now, stale)
      .first<{ id: string; input_revision_id: string; attempt_count: number }>();
    if (job === null) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    const claimed = await env.ADMIN_DB.prepare(`UPDATE jobs SET state='claimed',worker_id=?1,updated_at=?2 WHERE id=?3 AND ${claimable}`)
      .bind(worker.id, now, job.id, stale)
      .run();
    if ((claimed.meta.changes ?? 0) === 1) {
      // The abandoned attempt, if there was one, is over; leave job_attempts honest about it.
      await env.ADMIN_DB.prepare(
        "UPDATE job_attempts SET state='failed',finished_at=COALESCE(finished_at,?1) WHERE job_id=?2 AND state='running'",
      )
        .bind(now, job.id)
        .run();
      return json({
        id: job.id,
        body: { schema_version: JOB_SCHEMA_VERSION, job_id: job.id, input_revision_id: job.input_revision_id },
        attempts: job.attempt_count + 1,
        leaseId: job.id,
      });
    }
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

async function generatorQueueAction(
  env: WorkerEnv,
  actor: Actor,
  action: "ack" | "retry",
  value: Record<string, unknown>,
): Promise<Response> {
  requirePermission(actor, "generator.jobs.read");
  const worker = await generatorActorWorker(env, actor);
  const jobId = requiredString(value.lease_id, 64);
  const job = await env.ADMIN_DB.prepare("SELECT state,worker_id FROM jobs WHERE id=?1")
    .bind(jobId)
    .first<{ state: string; worker_id: string | null }>();
  if (job === null || job.worker_id !== worker.id) throw new ServiceError(409, "CONFLICT");
  const now = Date.now();
  if (action === "retry") {
    const delaySeconds = numberValue(value.delay_seconds ?? 30, 0, 300);
    if (!["claimed", "running", "failed"].includes(job.state)) throw new ServiceError(409, "CONFLICT");
    await env.ADMIN_DB.batch([
      env.ADMIN_DB.prepare(
        "UPDATE job_attempts SET state='failed',finished_at=COALESCE(finished_at,?1) WHERE job_id=?2 AND state='running'",
      ).bind(now, jobId),
      env.ADMIN_DB.prepare("UPDATE jobs SET state='queued',worker_id=NULL,available_at=?1,updated_at=?2 WHERE id=?3 AND worker_id=?4").bind(
        now + delaySeconds * 1000,
        now,
        jobId,
        worker.id,
      ),
    ]);
  } else {
    if (!["candidate_ready", "published", "review_required", "failed", "cancelled"].includes(job.state))
      throw new ServiceError(409, "CONFLICT");
    await env.ADMIN_DB.prepare("UPDATE job_attempts SET state=?1,finished_at=COALESCE(finished_at,?2) WHERE job_id=?3 AND state='running'")
      .bind(job.state === "failed" || job.state === "cancelled" ? "failed" : "completed", now, jobId)
      .run();
  }
  return json({ accepted: true });
}

async function generatorJob(env: WorkerEnv, actor: Actor, jobId: string): Promise<Response> {
  requirePermission(actor, "generator.jobs.read");
  const worker = await generatorActorWorker(env, actor);
  const row = await env.ADMIN_DB.prepare(
    `SELECT j.id job_id,j.input_revision_id,j.attempt_count,j.cancel_requested,j.state,j.worker_id,r.*,s.url FROM jobs j JOIN input_revisions i ON i.id=j.input_revision_id JOIN recordings r ON r.id=i.recording_id JOIN media_sources s ON s.id=i.source_id WHERE j.id=?1`,
  )
    .bind(jobId)
    .first<Record<string, unknown>>();
  if (row === null) throw new ServiceError(404, "NOT_FOUND");
  if (row.cancel_requested === 1) throw new ServiceError(409, "CANCELLED");
  if (row.state !== "claimed" || row.worker_id !== worker.id) throw new ServiceError(409, "CONFLICT");
  const attemptId = crypto.randomUUID();
  const startedAt = Date.now();
  const started = await env.ADMIN_DB.prepare(
    "UPDATE jobs SET state='running',attempt_count=attempt_count+1,updated_at=?1 WHERE id=?2 AND state='claimed' AND worker_id=?3",
  )
    .bind(startedAt, jobId, worker.id)
    .run();
  if ((started.meta.changes ?? 0) !== 1) throw new ServiceError(409, "CONFLICT");
  await env.ADMIN_DB.prepare("INSERT INTO job_attempts (id,job_id,worker_id,state,started_at) VALUES (?1,?2,?3,'running',?4)")
    .bind(attemptId, jobId, worker.id, startedAt)
    .run();
  const lyrics = await env.ADMIN_DB.prepare(
    "SELECT id,provider,provider_ref,language,text,preprocessor FROM lyric_revisions WHERE input_revision_id=?1 AND layer!='raw'",
  )
    .bind(String(row.input_revision_id))
    .all<Record<string, unknown>>();
  const alternatives = await env.ADMIN_DB.prepare(
    "SELECT url FROM media_sources WHERE recording_id=?1 AND selected=0 ORDER BY rank LIMIT 2",
  )
    .bind(String(row.id))
    .all<{ url: string }>();
  const output: GeneratorJobInput = {
    schema_version: JOB_SCHEMA_VERSION,
    job_id: jobId,
    attempt_id: attemptId,
    input_revision_id: String(row.input_revision_id),
    recording: {
      isrc: String(row.isrc),
      ...(typeof row.mbid === "string" ? { mbid: row.mbid } : {}),
      artist: String(row.artist),
      title: String(row.title),
      ...(typeof row.album === "string" ? { album: row.album } : {}),
      duration_ms: Number(row.duration_ms),
      language: String(row.language),
    },
    source: { url: String(row.url), alternatives: alternatives.results.map((item) => item.url), max_duration_ms: 900_000 },
    lyrics: lyrics.results.map((item) => ({
      id: String(item.id),
      provider: String(item.provider),
      ...(typeof item.provider_ref === "string" ? { provider_ref: item.provider_ref } : {}),
      language: String(item.language),
      text: String(item.text),
      preprocessing_version: String(item.preprocessor),
    })),
    pipeline: { version: "production-v1", profile: "production-v1" },
  };
  return json(output);
}

const PIPELINE_STAGES: readonly string[] = [
  "probe",
  "download",
  "transcode",
  "separate",
  "coarse_asr",
  "language_validate",
  "forced_align",
  "diarize",
  "speaker_stems",
  "index",
  "quality_gate",
  "candidate_submit",
  "cleanup",
];
const STAGE_STATES: readonly string[] = ["started", "progress", "completed", "failed"];

async function stageEvent(env: WorkerEnv, actor: Actor, value: Record<string, unknown>): Promise<Response> {
  requirePermission(actor, "generator.events.write");
  // The payload reached the database unchecked before, so a stage was whatever the body said.
  const jobId = requiredString(value.job_id, 64);
  await requireOwnedJob(env, actor, jobId);
  if (!PIPELINE_STAGES.includes(requiredString(value.stage, 40))) throw new ServiceError(400, "INVALID_REQUEST");
  if (!STAGE_STATES.includes(requiredString(value.state, 20))) throw new ServiceError(400, "INVALID_REQUEST");
  const item: StageEvent = {
    job_id: jobId,
    attempt_id: requiredString(value.attempt_id, 64),
    stage: value.stage as StageEvent["stage"],
    state: value.state as StageEvent["state"],
    ...(value.progress === undefined ? {} : { progress: numberValue(value.progress, 0, 1) }),
    ...(value.code === undefined ? {} : { code: requiredString(value.code, 100) }),
    ...(typeof value.metrics === "object" && value.metrics !== null && !Array.isArray(value.metrics)
      ? { metrics: value.metrics as Record<string, number> }
      : {}),
    at: Date.now(),
  };
  const now = Date.now();
  // A language the aligner cannot handle is not a retryable failure.
  const nextState = item.state === "failed" ? (item.code === "UNSUPPORTED_LANGUAGE" ? "unsupported_language" : "failed") : "running";
  await env.ADMIN_DB.batch([
    env.ADMIN_DB.prepare(
      "INSERT INTO stage_events (job_id,attempt_id,stage,state,progress,code,metrics,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
    ).bind(
      item.job_id,
      item.attempt_id,
      item.stage,
      item.state,
      item.progress ?? null,
      item.code ?? null,
      JSON.stringify(item.metrics ?? {}),
      now,
    ),
    // Stage events keep arriving after the job settles; they must not walk a finished job back to running.
    env.ADMIN_DB.prepare(
      "UPDATE jobs SET state=CASE WHEN state IN ('candidate_ready','published','cancelled','unsupported_language') THEN state ELSE ?1 END,current_stage=?2,progress=?3,error_code=?4,updated_at=?5 WHERE id=?6",
    ).bind(nextState, item.stage, item.progress ?? (item.state === "completed" ? 1 : 0), item.code ?? null, now, item.job_id),
  ]);
  await event(env, "job.stage", { job_id: item.job_id, stage: item.stage, state: item.state, progress: item.progress ?? null });
  return json({ accepted: true }, 202);
}

function qualityScore(quality: Record<string, number>): number {
  const keys = ["token_coverage", "monotonicity", "duration_match", "language_match"];
  return keys.reduce((sum, key) => sum + Math.max(0, Math.min(1, quality[key] ?? 0)), 0) / keys.length;
}

async function submitCandidates(env: WorkerEnv, actor: Actor, value: Record<string, unknown>): Promise<Response> {
  requirePermission(actor, "generator.candidates.write");
  const submission = value as unknown as GeneratorCandidateSubmission;
  if (submission.schema_version !== JOB_SCHEMA_VERSION || !Array.isArray(submission.alignments))
    throw new ServiceError(400, "INVALID_REQUEST");
  await requireOwnedJob(env, actor, requiredString(submission.job_id, 64));
  // The revision has to be the one this job was handed, or a candidate lands against lyrics
  // the job never processed — and with auto-promotion on, straight into the public data.
  const owned = await env.ADMIN_DB.prepare("SELECT 1 FROM jobs WHERE id=?1 AND input_revision_id=?2")
    .bind(submission.job_id, requiredString(submission.input_revision_id, 64))
    .first();
  if (owned === null) throw new ServiceError(409, "CONFLICT");
  const ids: string[] = [];
  const scores: Array<{ id: string; score: number; language: number }> = [];
  for (const candidate of submission.alignments) {
    const id = crypto.randomUUID();
    ids.push(id);
    const score = qualityScore(candidate.quality);
    scores.push({ id, score, language: candidate.quality.language_match ?? 0 });
    await env.ADMIN_DB.prepare(
      `INSERT INTO alignment_candidates (id,job_id,input_revision_id,variant_id,status,tokenizer,text_hash,fp_lens,fp_types,line_spans,word_spans,speaker_turns,word_speakers,line_speakers,quality,quality_score,pipeline_version,backend,hardware,created_by,created_at) VALUES (?1,?2,?3,?4,'pending',?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)`,
    )
      .bind(
        id,
        submission.job_id,
        submission.input_revision_id,
        candidate.variant_id,
        candidate.tokenizer,
        candidate.text_hash,
        encode(candidate.fingerprint.lens),
        encode(candidate.fingerprint.types),
        encode(candidate.line_spans),
        encode(candidate.word_spans.map(([index, start, end]) => [index, start, end])),
        encode(candidate.speaker_turns),
        encode(candidate.word_speakers),
        encode(candidate.line_speakers),
        JSON.stringify(candidate.quality),
        score,
        submission.pipeline_version,
        submission.backend,
        submission.hardware,
        actor.id,
        Date.now(),
      )
      .run();
  }
  await env.ADMIN_DB.prepare(
    "UPDATE jobs SET state='candidate_ready',progress=1,current_stage='candidate_submit',updated_at=?1 WHERE id=?2",
  )
    .bind(Date.now(), submission.job_id)
    .run();
  await audit(env, actor, "candidate.submit", "job", submission.job_id, { candidate_ids: ids });
  await event(env, "candidate.ready", { job_id: submission.job_id, candidate_ids: ids });
  const settings = await env.ADMIN_DB.prepare(
    "SELECT key,value FROM settings WHERE key IN ('auto_promotion_enabled','quality_threshold')",
  ).all<{ key: string; value: string }>();
  const values = Object.fromEntries(settings.results.map((item) => [item.key, item.value]));
  let published = 0;
  if (values.auto_promotion_enabled === "true") {
    const threshold = Number(values.quality_threshold ?? "0.9");
    const system: Actor = { type: "service", id: "quality-gate", permissions: new Set(["*"]) };
    for (const item of scores)
      if (item.score >= threshold && item.language >= 0.9) {
        await promote(env, system, item.id);
        published += 1;
      }
  }
  return json({ candidate_ids: ids, state: published === ids.length && ids.length > 0 ? "published" : "review_required", published }, 201);
}

async function promote(env: WorkerEnv, actor: Actor, candidateId: string): Promise<Response> {
  requirePermission(actor, "candidates.approve");
  const row = await env.ADMIN_DB.prepare(
    `SELECT c.*,r.isrc,r.mbid,r.artist,r.title,r.duration_ms FROM alignment_candidates c JOIN input_revisions i ON i.id=c.input_revision_id JOIN recordings r ON r.id=i.recording_id WHERE c.id=?1`,
  )
    .bind(candidateId)
    .first<Record<string, unknown>>();
  if (row === null) throw new ServiceError(404, "NOT_FOUND");
  const publicWrite = env.PUBLIC_DB.prepare(
    `INSERT INTO public_recording (isrc,mbid,artist_key,title_key,duration_ms) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(isrc) DO UPDATE SET mbid=COALESCE(excluded.mbid,public_recording.mbid),artist_key=excluded.artist_key,title_key=excluded.title_key,duration_ms=excluded.duration_ms`,
  ).bind(
    row.isrc,
    row.mbid ?? null,
    String(row.artist).normalize("NFKC").toLowerCase(),
    String(row.title).normalize("NFKC").toLowerCase(),
    row.duration_ms,
  );
  const alignmentWrite = env.PUBLIC_DB.prepare(
    `INSERT INTO public_alignment (revision_id,isrc,text_hash,tokenizer,fp_lens,fp_types,line_spans,word_spans,speaker_turns,word_speakers,line_speakers,quality_score,source,active,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'manual',1,?13) ON CONFLICT(isrc,text_hash,tokenizer) DO UPDATE SET revision_id=excluded.revision_id,fp_lens=excluded.fp_lens,fp_types=excluded.fp_types,line_spans=excluded.line_spans,word_spans=excluded.word_spans,speaker_turns=excluded.speaker_turns,word_speakers=excluded.word_speakers,line_speakers=excluded.line_speakers,quality_score=excluded.quality_score,active=1,created_at=excluded.created_at`,
  ).bind(
    candidateId,
    row.isrc,
    row.text_hash,
    row.tokenizer,
    row.fp_lens,
    row.fp_types,
    row.line_spans,
    row.word_spans,
    row.speaker_turns,
    row.word_speakers,
    row.line_speakers,
    row.quality_score,
    Date.now(),
  );
  const results = await env.PUBLIC_DB.batch([publicWrite, alignmentWrite]);
  const publicId = Number(results[1]?.meta.last_row_id ?? 0);
  const releaseId = crypto.randomUUID();
  try {
    await env.ADMIN_DB.batch([
      env.ADMIN_DB.prepare("UPDATE alignment_candidates SET status='published' WHERE id=?1").bind(candidateId),
      env.ADMIN_DB.prepare(
        "INSERT INTO releases (id,recording_id,candidate_id,public_alignment_id,state,policy_version,created_by,created_at) VALUES (?1,(SELECT recording_id FROM input_revisions WHERE id=?2),?3,?4,'active','manual-v1',?5,?6)",
      ).bind(releaseId, row.input_revision_id, candidateId, publicId, actor.id, Date.now()),
    ]);
  } catch (error) {
    // D1 has no transaction across databases. Withdrawing is driven by the release row, so a
    // public alignment without one is live with no way to take it down from the console —
    // undo the public write rather than leave that behind.
    await env.PUBLIC_DB.prepare("UPDATE public_alignment SET active=0 WHERE revision_id=?1").bind(candidateId).run();
    throw error;
  }
  if (actor.type === "user") {
    const current = await env.ADMIN_DB.prepare("SELECT value FROM settings WHERE key='calibration_reviews'").first<{ value: string }>();
    const count = Number(current?.value ?? 0) + 1;
    await env.ADMIN_DB.batch([
      env.ADMIN_DB.prepare(
        "INSERT INTO settings (key,value,updated_by,updated_at) VALUES ('calibration_reviews',?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
      ).bind(String(count), actor.id, Date.now()),
      ...(count >= CALIBRATION_TARGET
        ? [
            env.ADMIN_DB.prepare(
              "INSERT INTO settings (key,value,updated_by,updated_at) VALUES ('auto_promotion_enabled','true',?1,?2) ON CONFLICT(key) DO UPDATE SET value='true',updated_by=excluded.updated_by,updated_at=excluded.updated_at",
            ).bind(actor.id, Date.now()),
          ]
        : []),
    ]);
  }
  await audit(env, actor, "release.promote", "candidate", candidateId, { release_id: releaseId });
  await event(env, "release.published", { candidate_id: candidateId, release_id: releaseId });
  return json({ release_id: releaseId, public_alignment_id: publicId }, 201);
}

async function withdrawRelease(env: WorkerEnv, actor: Actor, releaseId: string): Promise<Response> {
  requirePermission(actor, "releases.unpublish");
  const release = await env.ADMIN_DB.prepare("SELECT candidate_id FROM releases WHERE id=?1 AND state='active'")
    .bind(releaseId)
    .first<{ candidate_id: string }>();
  if (release === null) throw new ServiceError(404, "NOT_FOUND");
  await env.PUBLIC_DB.prepare("UPDATE public_alignment SET active=0 WHERE revision_id=?1").bind(release.candidate_id).run();
  await env.ADMIN_DB.batch([
    env.ADMIN_DB.prepare("UPDATE releases SET state='withdrawn' WHERE id=?1").bind(releaseId),
    env.ADMIN_DB.prepare("UPDATE alignment_candidates SET status='withdrawn' WHERE id=?1").bind(release.candidate_id),
  ]);
  await audit(env, actor, "release.withdraw", "release", releaseId);
  await event(env, "release.withdrawn", { release_id: releaseId });
  return json({ release_id: releaseId, state: "withdrawn" });
}

async function candidateDetail(env: WorkerEnv, actor: Actor, candidateId: string): Promise<Response> {
  requirePermission(actor, "candidates.read");
  const candidate = await env.ADMIN_DB.prepare(
    `SELECT c.*,l.text lyric_text,l.language lyric_language,l.provider lyric_provider,l.layer lyric_layer,r.artist recording_artist,r.title recording_title FROM alignment_candidates c JOIN lyric_revisions l ON l.id=c.variant_id JOIN input_revisions i ON i.id=c.input_revision_id JOIN recordings r ON r.id=i.recording_id WHERE c.id=?1`,
  )
    .bind(candidateId)
    .first<Record<string, unknown>>();
  if (candidate === null) throw new ServiceError(404, "NOT_FOUND");
  const artifacts = await env.ADMIN_DB.prepare(
    `SELECT a.id,a.kind,a.speaker_id,a.content_type,a.byte_size FROM artifacts a WHERE a.job_id=?1 AND a.deleted_at IS NULL AND a.content_type LIKE 'audio/%' AND NOT EXISTS(SELECT 1 FROM artifacts newer WHERE newer.job_id=a.job_id AND newer.kind=a.kind AND COALESCE(newer.speaker_id,-1)=COALESCE(a.speaker_id,-1) AND newer.deleted_at IS NULL AND newer.content_type LIKE 'audio/%' AND (newer.created_at>a.created_at OR (newer.created_at=a.created_at AND newer.id>a.id))) ORDER BY CASE a.kind WHEN 'source' THEN 0 WHEN 'vocals' THEN 1 WHEN 'speaker' THEN 2 WHEN 'drums' THEN 3 WHEN 'bass' THEN 4 ELSE 5 END,a.speaker_id`,
  )
    .bind(candidate.job_id)
    .all<Record<string, unknown>>();
  const wordSpeakers = decode<Array<[number, number, number]>>(candidate.word_speakers as ArrayBuffer);
  const lyricText = String(candidate.lyric_text);
  const review = buildReviewLyrics(lyricText, String(candidate.lyric_language), wordSpeakers);
  return json({
    id: candidate.id,
    job_id: candidate.job_id,
    recording: { artist: candidate.recording_artist, title: candidate.recording_title },
    variant: { provider: candidate.lyric_provider, language: candidate.lyric_language, layer: candidate.lyric_layer },
    lyric_text: lyricText,
    ...review,
    line_spans: decode(candidate.line_spans as ArrayBuffer),
    word_spans: decode(candidate.word_spans as ArrayBuffer),
    speaker_turns: decode(candidate.speaker_turns as ArrayBuffer),
    word_speakers: wordSpeakers,
    line_speakers: decode(candidate.line_speakers as ArrayBuffer),
    quality: JSON.parse(String(candidate.quality)),
    artifacts: artifacts.results,
  });
}

async function acquireLease(env: WorkerEnv, actor: Actor, candidateId: string, force: boolean): Promise<Response> {
  requirePermission(actor, "timing.edit");
  const existing = await env.ADMIN_DB.prepare("SELECT user_id,expires_at FROM edit_leases WHERE candidate_id=?1")
    .bind(candidateId)
    .first<{ user_id: string; expires_at: number }>();
  if (existing !== null && existing.expires_at > Date.now() && existing.user_id !== actor.id && !force)
    throw new ServiceError(423, "EDIT_LOCKED");
  if (existing !== null && existing.user_id !== actor.id && force) requirePermission(actor, "timing.lease.force");
  await env.ADMIN_DB.prepare(
    "INSERT INTO edit_leases (candidate_id,user_id,expires_at,updated_at) VALUES (?1,?2,?3,?4) ON CONFLICT(candidate_id) DO UPDATE SET user_id=excluded.user_id,expires_at=excluded.expires_at,updated_at=excluded.updated_at",
  )
    .bind(candidateId, actor.id, Date.now() + 10 * 60_000, Date.now())
    .run();
  await audit(
    env,
    actor,
    existing !== null && existing.user_id !== actor.id ? "edit.lease.force" : "edit.lease.acquire",
    "candidate",
    candidateId,
  );
  return json({ candidate_id: candidateId, holder: actor.id, expires_at: Date.now() + 10 * 60_000 });
}

function validDraft(value: Record<string, unknown>): boolean {
  const lines = value.line_spans;
  const words = value.word_spans;
  if (!Array.isArray(lines) || !Array.isArray(words)) return false;
  let previous = 0;
  for (const row of lines) {
    if (
      !Array.isArray(row) ||
      row.length !== 2 ||
      row.some((item) => typeof item !== "number") ||
      Number(row[0]) < previous ||
      Number(row[1]) <= Number(row[0])
    )
      return false;
    previous = Number(row[1]);
  }
  previous = 0;
  for (const row of words) {
    if (
      !Array.isArray(row) ||
      row.length < 3 ||
      row.some((item, index) => index < 3 && typeof item !== "number") ||
      Number(row[1]) < previous ||
      Number(row[2]) <= Number(row[1])
    )
      return false;
    previous = Number(row[2]);
  }
  return true;
}

async function saveDraft(env: WorkerEnv, actor: Actor, candidateId: string, value: Record<string, unknown>): Promise<Response> {
  requirePermission(actor, "timing.edit");
  const lease = await env.ADMIN_DB.prepare("SELECT user_id,expires_at FROM edit_leases WHERE candidate_id=?1")
    .bind(candidateId)
    .first<{ user_id: string; expires_at: number }>();
  if (lease === null || lease.user_id !== actor.id || lease.expires_at < Date.now()) throw new ServiceError(423, "EDIT_LOCKED");
  const valid = validDraft(value);
  await env.ADMIN_DB.batch([
    env.ADMIN_DB.prepare(
      "INSERT INTO draft_edits (candidate_id,user_id,data,valid,updated_at) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(candidate_id,user_id) DO UPDATE SET data=excluded.data,valid=excluded.valid,updated_at=excluded.updated_at",
    ).bind(candidateId, actor.id, JSON.stringify(value), valid ? 1 : 0, Date.now()),
    env.ADMIN_DB.prepare("UPDATE edit_leases SET expires_at=?1,updated_at=?2 WHERE candidate_id=?3").bind(
      Date.now() + 10 * 60_000,
      Date.now(),
      candidateId,
    ),
  ]);
  return json({ saved: true, valid });
}

async function submitDraft(env: WorkerEnv, actor: Actor, candidateId: string): Promise<Response> {
  requirePermission(actor, "timing.edit");
  const draft = await env.ADMIN_DB.prepare("SELECT data,valid FROM draft_edits WHERE candidate_id=?1 AND user_id=?2")
    .bind(candidateId, actor.id)
    .first<{ data: string; valid: number }>();
  if (draft === null) throw new ServiceError(404, "NOT_FOUND");
  if (draft.valid !== 1) throw new ServiceError(409, "INVALID_DRAFT");
  const source = await env.ADMIN_DB.prepare("SELECT * FROM alignment_candidates WHERE id=?1")
    .bind(candidateId)
    .first<Record<string, unknown>>();
  if (source === null) throw new ServiceError(404, "NOT_FOUND");
  const data = JSON.parse(draft.data) as Record<string, unknown>;
  const id = crypto.randomUUID();
  await env.ADMIN_DB.batch([
    env.ADMIN_DB.prepare(
      `INSERT INTO alignment_candidates (id,job_id,input_revision_id,variant_id,parent_id,status,tokenizer,text_hash,fp_lens,fp_types,line_spans,word_spans,speaker_turns,word_speakers,line_speakers,quality,quality_score,pipeline_version,backend,hardware,created_by,created_at) VALUES (?1,?2,?3,?4,?5,'pending',?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)`,
    ).bind(
      id,
      source.job_id,
      source.input_revision_id,
      source.variant_id,
      candidateId,
      source.tokenizer,
      source.text_hash,
      source.fp_lens,
      source.fp_types,
      encode(data.line_spans),
      encode(data.word_spans),
      source.speaker_turns,
      source.word_speakers,
      source.line_speakers,
      source.quality,
      source.quality_score,
      source.pipeline_version,
      source.backend,
      source.hardware,
      actor.id,
      Date.now(),
    ),
    env.ADMIN_DB.prepare("DELETE FROM draft_edits WHERE candidate_id=?1 AND user_id=?2").bind(candidateId, actor.id),
    env.ADMIN_DB.prepare("DELETE FROM edit_leases WHERE candidate_id=?1").bind(candidateId),
  ]);
  await audit(env, actor, "candidate.revise", "candidate", id, { parent_id: candidateId });
  await event(env, "candidate.revised", { candidate_id: id, parent_id: candidateId });
  return json({ candidate_id: id }, 201);
}

async function jobAction(env: WorkerEnv, actor: Actor, jobId: string, action: string): Promise<Response> {
  requirePermission(actor, "jobs.manage");
  const now = Date.now();
  if (action === "cancel")
    await env.ADMIN_DB.prepare(
      "UPDATE jobs SET cancel_requested=1,state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END,updated_at=?1 WHERE id=?2",
    )
      .bind(now, jobId)
      .run();
  else if (action === "retry") {
    const row = await env.ADMIN_DB.prepare("SELECT input_revision_id,attempt_count,max_attempts FROM jobs WHERE id=?1")
      .bind(jobId)
      .first<{ input_revision_id: string; attempt_count: number; max_attempts: number }>();
    if (row === null) throw new ServiceError(404, "NOT_FOUND");
    if (row.attempt_count >= row.max_attempts) throw new ServiceError(409, "ATTEMPT_LIMIT");
    await env.ADMIN_DB.prepare(
      "UPDATE jobs SET state='queued',cancel_requested=0,error_code=NULL,available_at=?1,updated_at=?1 WHERE id=?2",
    )
      .bind(now, jobId)
      .run();
  } else throw new ServiceError(404, "NOT_FOUND");
  await audit(env, actor, `job.${action}`, "job", jobId);
  await event(env, `job.${action}`, { job_id: jobId });
  return json({ job_id: jobId, action }, 202);
}

async function registerArtifact(env: WorkerEnv, actor: Actor, value: Record<string, unknown>): Promise<Response> {
  requirePermission(actor, "generator.artifacts.write");
  const jobId = requiredString(value.job_id, 64);
  await requireOwnedJob(env, actor, jobId);
  const id = crypto.randomUUID();
  const r2Key = `jobs/${jobId}/${id}`;
  await env.ADMIN_DB.prepare(
    `INSERT INTO artifacts (id,job_id,kind,speaker_id,r2_key,content_type,byte_size,sha256,encryption,wrapped_key,chunk_size,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
  )
    .bind(
      id,
      value.job_id,
      requiredString(value.kind, 50),
      typeof value.speaker_id === "number" ? value.speaker_id : null,
      r2Key,
      requiredString(value.content_type, 100),
      numberValue(value.byte_size),
      requiredString(value.sha256, 128),
      requiredString(value.encryption, 100),
      requiredString(value.wrapped_key, 4096),
      numberValue(value.chunk_size, 1),
      Date.now(),
    )
    .run();
  return json({ artifact_id: id, upload_path: `/admin/api/generator/artifacts/${id}/content` }, 201);
}

async function artifactContent(request: Request, env: WorkerEnv, actor: Actor, artifactId: string): Promise<Response> {
  const row = await env.ADMIN_DB.prepare(
    "SELECT r2_key,content_type,byte_size,wrapped_key,chunk_size,encryption FROM artifacts WHERE id=?1 AND deleted_at IS NULL",
  )
    .bind(artifactId)
    .first<{ r2_key: string; content_type: string; byte_size: number; wrapped_key: string; chunk_size: number; encryption: string }>();
  if (row === null) throw new ServiceError(404, "NOT_FOUND");
  if (request.method === "PUT") {
    requirePermission(actor, "generator.artifacts.write");
    await env.ADMIN_ARTIFACTS.put(row.r2_key, request.body, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { artifactId },
    });
    return new Response(null, { status: 204 });
  }
  requirePermission(actor, "artifacts.read");
  return serveArtifact(request, env, row);
}

async function workerHeartbeat(env: WorkerEnv, actor: Actor, value: Record<string, unknown>): Promise<Response> {
  requirePermission(actor, "workers.heartbeat");
  const workerId = requiredString(value.worker_id, 100);
  const worker = await generatorActorWorker(env, actor);
  if (worker.id !== workerId) throw new ServiceError(403, "FORBIDDEN");
  await env.ADMIN_DB.prepare("UPDATE workers SET last_seen_at=?1,version=?2 WHERE id=?3")
    .bind(Date.now(), requiredString(value.version, 100), workerId)
    .run();
  const state = await env.ADMIN_DB.prepare("SELECT desired_state FROM workers WHERE id=?1")
    .bind(workerId)
    .first<{ desired_state: string }>();
  return json({ desired_state: state?.desired_state ?? "paused", server_time: Date.now() });
}

async function setWorkerState(env: WorkerEnv, actor: Actor, workerId: string, value: Record<string, unknown>): Promise<Response> {
  requirePermission(actor, "workers.manage");
  const desired = requiredString(value.desired_state, 20);
  if (!WORKER_STATES.includes(desired as (typeof WORKER_STATES)[number])) throw new ServiceError(400, "INVALID_REQUEST");
  const updated = await env.ADMIN_DB.prepare("UPDATE workers SET desired_state=?1 WHERE id=?2").bind(desired, workerId).run();
  if ((updated.meta.changes ?? 0) !== 1) throw new ServiceError(404, "NOT_FOUND");
  await audit(env, actor, "worker.state", "worker", workerId, { desired_state: desired });
  await event(env, "worker.state", { worker_id: workerId, desired_state: desired });
  return json({ worker_id: workerId, desired_state: desired });
}

async function dispatchNotifications(env: WorkerEnv, type: string, data: Record<string, unknown>): Promise<void> {
  if (!["job.failed", "worker.offline", "queue.backlog", "canary.regression", "auth.anomaly"].includes(type)) return;
  const targets = await env.ADMIN_DB.prepare("SELECT kind,url_ciphertext FROM notification_targets WHERE enabled=1").all<{
    kind: string;
    url_ciphertext: string;
  }>();
  const timeoutMs = Number((await runtimeValue(env, "server.notification_timeout_ms")) ?? 5000);
  await Promise.all(
    targets.results.map(async (target) => {
      try {
        const targetUrl = await openSecret(env, target.url_ciphertext);
        if (!targetUrl.startsWith("https://")) return;
        const payload =
          target.kind === "discord"
            ? {
                embeds: [
                  {
                    title: `Mora: ${type}`,
                    description: "관리자 확인이 필요합니다.",
                    color: 0xe0a84b,
                    fields: Object.entries(data)
                      .slice(0, 10)
                      .map(([name, value]) => ({ name, value: String(value), inline: true })),
                    timestamp: new Date().toISOString(),
                  },
                ],
              }
            : { type, data, at: Date.now() };
        const serialized = JSON.stringify(payload);
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (target.kind === "webhook") {
          const signature = await webhookSignature(env, serialized);
          if (signature !== undefined) headers["X-Mora-Signature"] = signature;
        }
        await fetch(targetUrl, { method: "POST", headers, body: serialized, signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        /* diagnostic only; never include secrets */
      }
    }),
  );
}

export async function handleAdmin(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/admin/api/auth/status") {
    const count = await env.ADMIN_DB.prepare("SELECT COUNT(*) count FROM webauthn_credentials").first<{ count: number }>();
    try {
      return json({ bootstrapped: (count?.count ?? 0) > 0, actor: actorJson(await authenticate(request, env)) });
    } catch {
      return json({ bootstrapped: (count?.count ?? 0) > 0, actor: null });
    }
  }
  if (request.method === "POST" && url.pathname === "/admin/api/auth/bootstrap/options")
    return json(await bootstrapOptions(request, env, await body(request)));
  if (request.method === "POST" && url.pathname === "/admin/api/auth/bootstrap/verify") {
    const result = await bootstrapVerify(request, env, await body(request));
    return json({ user_id: result.user_id }, 201, { "Set-Cookie": result.cookie });
  }
  if (request.method === "POST" && url.pathname === "/admin/api/auth/credential/options")
    return json(await credentialOptions(request, env, await body(request)));
  if (request.method === "POST" && url.pathname === "/admin/api/auth/credential/verify") {
    const result = await credentialVerify(request, env, await body(request));
    return json({ user_id: result.user_id }, 201, { "Set-Cookie": result.cookie });
  }
  if (request.method === "POST" && url.pathname === "/admin/api/auth/login/options")
    return json(await loginOptions(request, env, await body(request)));
  if (request.method === "POST" && url.pathname === "/admin/api/auth/login/verify") {
    const result = await loginVerify(request, env, await body(request));
    return json({ user_id: result.user_id }, 200, { "Set-Cookie": result.cookie });
  }
  if (request.method === "POST" && url.pathname === "/admin/api/auth/logout")
    return json({ ok: true }, 200, { "Set-Cookie": await logout(request, env) });
  if (request.method === "POST" && url.pathname === "/admin/api/generator/enroll") return enrollWorker(env, await body(request));
  if (request.method === "POST" && url.pathname === "/admin/api/generator/pairings")
    return startGeneratorPairing(env, await body(request, 64 * 1024));
  const generatorPairingMatch = url.pathname.match(/^\/admin\/api\/generator\/pairings\/([^/]+)$/u);
  if (request.method === "GET" && generatorPairingMatch?.[1] !== undefined)
    return pollGeneratorPairing(request, env, generatorPairingMatch[1]);
  if (request.method === "POST" && url.pathname === "/admin/api/collector/pairings")
    return startCollectorPairing(env, await body(request, 16 * 1024));
  const pairingMatch = url.pathname.match(/^\/admin\/api\/collector\/pairings\/([^/]+)$/u);
  if (request.method === "GET" && pairingMatch?.[1] !== undefined) return pollCollectorPairing(request, env, pairingMatch[1]);

  const actor = await authenticate(request, env);
  if (request.method === "GET" && url.pathname === "/admin/api/events") {
    requirePermission(actor, "dashboard.read");
    return env.ADMIN_EVENTS.get(env.ADMIN_EVENTS.idFromName("global")).fetch("https://events.internal/subscribe");
  }
  if (request.method === "GET" && url.pathname === "/admin/api/overview") {
    requirePermission(actor, "dashboard.read");
    return json(await overview(env));
  }
  if (request.method === "GET" && url.pathname === "/admin/api/jobs") {
    requirePermission(actor, "jobs.read");
    // The queue is read as "which song is where", so every row carries its song.
    return json({
      items: await list(
        env.ADMIN_DB,
        `SELECT j.*, r.artist, r.title, r.isrc
         FROM jobs j
         JOIN input_revisions i ON i.id = j.input_revision_id
         JOIN recordings r ON r.id = i.recording_id
         ORDER BY j.created_at DESC LIMIT 200`,
      ),
    });
  }
  if (request.method === "GET" && url.pathname === "/admin/api/workers") {
    requirePermission(actor, "workers.read");
    return json({
      items: await list(
        env.ADMIN_DB,
        "SELECT id,name,version,backend,hardware,capabilities,self_test,production_ready,desired_state,last_seen_at,created_at FROM workers ORDER BY last_seen_at DESC",
      ),
    });
  }
  if (request.method === "GET" && url.pathname === "/admin/api/recordings") {
    requirePermission(actor, "recordings.read");
    return json({
      items: await list(
        env.ADMIN_DB,
        `
      SELECT r.*,
        (SELECT COUNT(*) FROM input_revisions i WHERE i.recording_id=r.id) revision_count,
        (SELECT COUNT(*) FROM alignment_candidates c JOIN input_revisions i ON i.id=c.input_revision_id WHERE i.recording_id=r.id) alignment_count,
        (SELECT COUNT(*) FROM media_sources s WHERE s.recording_id=r.id) source_count,
        (SELECT j.state FROM jobs j JOIN input_revisions i ON i.id=j.input_revision_id WHERE i.recording_id=r.id ORDER BY j.created_at DESC LIMIT 1) job_state,
        (SELECT j.current_stage FROM jobs j JOIN input_revisions i ON i.id=j.input_revision_id WHERE i.recording_id=r.id ORDER BY j.created_at DESC LIMIT 1) current_stage,
        EXISTS(SELECT 1 FROM releases x WHERE x.recording_id=r.id AND x.state='active') published
      FROM recordings r ORDER BY r.created_at DESC LIMIT 200
    `,
      ),
    });
  }
  if (request.method === "GET" && url.pathname === "/admin/api/candidates") {
    requirePermission(actor, "candidates.read");
    return json({
      items: await list(
        env.ADMIN_DB,
        "SELECT id,job_id,input_revision_id,variant_id,status,tokenizer,text_hash,quality,quality_score,pipeline_version,backend,hardware,created_at FROM alignment_candidates ORDER BY created_at DESC LIMIT 200",
      ),
    });
  }
  if (request.method === "GET" && url.pathname === "/admin/api/reviews") return reviewQueues(env, actor);
  if (request.method === "GET" && url.pathname === "/admin/api/audit") {
    requirePermission(actor, "audit.read");
    return json({ items: await list(env.ADMIN_DB, "SELECT * FROM audit_log ORDER BY id DESC LIMIT 500") });
  }
  if (request.method === "GET" && url.pathname === "/admin/api/releases") {
    requirePermission(actor, "releases.read");
    return json({
      items: await list(
        env.ADMIN_DB,
        `SELECT x.*, r.artist, r.title, r.isrc
         FROM releases x JOIN recordings r ON r.id = x.recording_id
         ORDER BY x.created_at DESC LIMIT 500`,
      ),
    });
  }
  if (request.method === "GET" && url.pathname === "/admin/api/roles") {
    requirePermission(actor, "roles.read");
    return json({ items: await list(env.ADMIN_DB, "SELECT id,name,permissions,system,created_at FROM roles ORDER BY name") });
  }
  if (request.method === "GET" && url.pathname === "/admin/api/users") {
    requirePermission(actor, "roles.read");
    return json({
      items: await list(
        env.ADMIN_DB,
        `
      SELECT u.id,u.email,u.display_name,u.status,u.created_at,
        (SELECT json_group_array(ur.role_id) FROM user_roles ur WHERE ur.user_id=u.id) role_ids
      FROM users u ORDER BY u.created_at
    `,
      ),
    });
  }
  if (request.method === "GET" && url.pathname === "/admin/api/service-keys") {
    requirePermission(actor, "service_keys.manage");
    return json({
      items: await list(
        env.ADMIN_DB,
        "SELECT id,name,prefix,scopes,expires_at,revoked_at,last_used_at,created_at FROM service_keys ORDER BY created_at DESC LIMIT 200",
      ),
    });
  }
  if (request.method === "GET" && url.pathname === "/admin/api/settings") return listRuntimeConfig(env, actor);
  if (request.method === "GET" && url.pathname === "/admin/api/collector/config") return collectorRuntimeConfig(env, actor);
  if (request.method === "GET" && url.pathname === "/admin/api/collector/collected") return collectorCollected(env, actor);
  if (request.method === "POST" && url.pathname === "/admin/api/collector/pairings/approve")
    return approveCollectorPairing(env, actor, await body(request, 16 * 1024));
  if (request.method === "POST" && url.pathname === "/admin/api/generator/pairings/approve")
    return approveGeneratorPairing(env, actor, await body(request, 16 * 1024));
  if (request.method === "POST" && url.pathname === "/admin/api/service-keys") return createServiceKey(env, actor, await body(request));
  if (request.method === "POST" && url.pathname === "/admin/api/roles") return upsertRole(env, actor, await body(request));
  if (request.method === "POST" && url.pathname === "/admin/api/notifications") return addNotification(env, actor, await body(request));
  if (request.method === "POST" && url.pathname === "/admin/api/workers/enrollment") return createEnrollment(env, actor);
  if (request.method === "POST" && url.pathname === "/admin/api/collector/recordings")
    return collectorSubmit(env, actor, await body(request));
  if (request.method === "POST" && url.pathname === "/admin/api/generator/events") return stageEvent(env, actor, await body(request));
  if (request.method === "POST" && url.pathname === "/admin/api/generator/candidates")
    return submitCandidates(env, actor, await body(request));
  if (request.method === "POST" && url.pathname === "/admin/api/generator/artifacts")
    return registerArtifact(env, actor, await body(request));
  if (request.method === "POST" && url.pathname === "/admin/api/generator/heartbeat")
    return workerHeartbeat(env, actor, await body(request));
  if (request.method === "POST" && url.pathname === "/admin/api/generator/queue/pull") return generatorQueuePull(env, actor);
  if (request.method === "POST" && url.pathname === "/admin/api/generator/queue/ack")
    return generatorQueueAction(env, actor, "ack", await body(request, 16 * 1024));
  if (request.method === "POST" && url.pathname === "/admin/api/generator/queue/retry")
    return generatorQueueAction(env, actor, "retry", await body(request, 16 * 1024));

  let match = url.pathname.match(/^\/admin\/api\/generator\/jobs\/([^/]+)$/u);
  if (request.method === "GET" && match?.[1] !== undefined) return generatorJob(env, actor, match[1]);
  match = url.pathname.match(/^\/admin\/api\/generator\/artifacts\/([^/]+)\/content$/u);
  if ((request.method === "PUT" || request.method === "GET") && match?.[1] !== undefined)
    return artifactContent(request, env, actor, match[1]);
  match = url.pathname.match(/^\/admin\/api\/jobs\/([^/]+)\/(retry|cancel)$/u);
  if (request.method === "POST" && match?.[1] !== undefined && match[2] !== undefined) return jobAction(env, actor, match[1], match[2]);
  match = url.pathname.match(/^\/admin\/api\/candidates\/([^/]+)\/approve$/u);
  if (request.method === "POST" && match?.[1] !== undefined) return promote(env, actor, match[1]);
  match = url.pathname.match(/^\/admin\/api\/candidates\/([^/]+)$/u);
  if (request.method === "GET" && match?.[1] !== undefined) return candidateDetail(env, actor, match[1]);
  match = url.pathname.match(/^\/admin\/api\/candidates\/([^/]+)\/lease$/u);
  if (request.method === "POST" && match?.[1] !== undefined)
    return acquireLease(env, actor, match[1], url.searchParams.get("force") === "1");
  match = url.pathname.match(/^\/admin\/api\/candidates\/([^/]+)\/draft$/u);
  if (request.method === "PUT" && match?.[1] !== undefined) return saveDraft(env, actor, match[1], await body(request));
  match = url.pathname.match(/^\/admin\/api\/candidates\/([^/]+)\/submit-draft$/u);
  if (request.method === "POST" && match?.[1] !== undefined) return submitDraft(env, actor, match[1]);
  match = url.pathname.match(/^\/admin\/api\/users\/([^/]+)\/roles$/u);
  if (request.method === "POST" && match?.[1] !== undefined) return assignRole(env, actor, match[1], await body(request));
  match = url.pathname.match(/^\/admin\/api\/users\/([^/]+)\/roles\/([^/]+)$/u);
  if (request.method === "DELETE" && match?.[1] !== undefined && match[2] !== undefined)
    return unassignRole(env, actor, match[1], match[2]);
  match = url.pathname.match(/^\/admin\/api\/workers\/([^/]+)\/state$/u);
  if (request.method === "POST" && match?.[1] !== undefined) return setWorkerState(env, actor, match[1], await body(request, 16 * 1024));
  match = url.pathname.match(/^\/admin\/api\/service-keys\/([^/]+)$/u);
  if (request.method === "DELETE" && match?.[1] !== undefined) return revokeServiceKey(env, actor, match[1]);
  match = url.pathname.match(/^\/admin\/api\/settings\/([^/]+)$/u);
  if (request.method === "PUT" && match?.[1] !== undefined)
    return putRuntimeConfig(env, actor, decodeURIComponent(match[1]), await body(request));
  if (request.method === "DELETE" && match?.[1] !== undefined) return deleteRuntimeConfig(env, actor, decodeURIComponent(match[1]));
  match = url.pathname.match(/^\/admin\/api\/source-reviews\/([^/]+)\/select$/u);
  if (request.method === "POST" && match?.[1] !== undefined)
    return selectSourceReview(env, actor, match[1], await body(request, 16 * 1024));
  match = url.pathname.match(/^\/admin\/api\/source-reviews\/([^/]+)$/u);
  if (request.method === "PUT" && match?.[1] !== undefined) return updateSourceReview(env, actor, match[1], await body(request));
  match = url.pathname.match(/^\/admin\/api\/releases\/([^/]+)\/withdraw$/u);
  if (request.method === "POST" && match?.[1] !== undefined) return withdrawRelease(env, actor, match[1]);
  throw new ServiceError(404, "NOT_FOUND");
}
