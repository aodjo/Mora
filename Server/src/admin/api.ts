import { preprocessLyrics } from "../../../packages/preprocess/src/index.js";
import { textHash } from "../../../packages/core/src/tokenization/fingerprint.js";
import { tokenizeV2 } from "../../../packages/core/src/tokenization/tokenizer-v2.js";
import { ServiceError } from "../../../packages/core/src/shared/errors.js";
import type { GeneratorCandidateSubmission, GeneratorJobInput, StageEvent, WorkerCapabilities } from "../../../packages/contracts/src/index.js";
import { JOB_SCHEMA_VERSION } from "../../../packages/contracts/src/index.js";
import type { WorkerEnv } from "../env.js";
import { audit, authenticate, requirePermission, sha256, type Actor } from "./auth.js";
import { publishAdminEvent } from "./events.js";
import { bootstrapOptions, bootstrapVerify, loginOptions, loginVerify, logout } from "./webauthn.js";
import { serveArtifact } from "./artifacts.js";
import {
  deleteRuntimeConfig,
  listRuntimeConfig,
  putRuntimeConfig,
  runtimeValue,
  webhookSignature,
} from "./runtime-config.js";
import { openSecret, sealSecret } from "./secrets.js";

const jsonHeaders = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" } as const;

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
  } catch { throw new ServiceError(400, "BAD_JSON"); }
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
  const [jobs, workers, candidates, recordings] = await Promise.all([
    env.ADMIN_DB.prepare("SELECT state, COUNT(*) count FROM jobs GROUP BY state").all<{ state: string; count: number }>(),
    env.ADMIN_DB.prepare("SELECT COUNT(*) total, SUM(CASE WHEN production_ready=1 AND desired_state='active' AND last_seen_at>?1 THEN 1 ELSE 0 END) healthy FROM workers").bind(Date.now() - 120_000).first<{ total: number; healthy: number }>(),
    env.ADMIN_DB.prepare("SELECT COUNT(*) count FROM alignment_candidates WHERE status='pending'").first<{ count: number }>(),
    env.ADMIN_DB.prepare("SELECT COUNT(*) count FROM recordings").first<{ count: number }>(),
  ]);
  return { jobs: Object.fromEntries(jobs.results.map((row) => [row.state, row.count])), workers: workers ?? { total: 0, healthy: 0 }, review_count: candidates?.count ?? 0, recording_count: recordings?.count ?? 0 };
}

async function list(database: D1Database, sql: string, bindings: unknown[] = []): Promise<unknown[]> {
  const result = await database.prepare(sql).bind(...bindings).all<Record<string, unknown>>();
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
    .bind(id, name, secret.slice(0, 13), await sha256(secret), JSON.stringify(scopes), Date.now()).run();
  await audit(env, actor, "service_key.create", "service_key", id, { name, scopes });
  return json({ id, secret, prefix: secret.slice(0, 13), scopes }, 201);
}

async function upsertRole(env:WorkerEnv,actor:Actor,value:Record<string,unknown>):Promise<Response>{requirePermission(actor,"roles.manage");const permissions=value.permissions;if(!Array.isArray(permissions)||permissions.some(item=>typeof item!=="string"))throw new ServiceError(400,"INVALID_REQUEST");const id=typeof value.id==="string"?value.id:crypto.randomUUID();await env.ADMIN_DB.prepare("INSERT INTO roles (id,name,permissions,created_at) VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET name=excluded.name,permissions=excluded.permissions").bind(id,requiredString(value.name,100),JSON.stringify(permissions),Date.now()).run();await audit(env,actor,"role.upsert","role",id,{permissions});return json({id},201);}
async function assignRole(env:WorkerEnv,actor:Actor,userId:string,value:Record<string,unknown>):Promise<Response>{requirePermission(actor,"roles.manage");const roleId=requiredString(value.role_id,100);await env.ADMIN_DB.prepare("INSERT OR IGNORE INTO user_roles (user_id,role_id) VALUES (?1,?2)").bind(userId,roleId).run();await audit(env,actor,"user.role.assign","user",userId,{role_id:roleId});return json({user_id:userId,role_id:roleId});}
async function addNotification(env:WorkerEnv,actor:Actor,value:Record<string,unknown>):Promise<Response>{requirePermission(actor,"notifications.manage");const kind=requiredString(value.kind,20);if(kind!=="webhook"&&kind!=="discord")throw new ServiceError(400,"INVALID_REQUEST");const targetUrl=requiredString(value.url,4096);const parsed=new URL(targetUrl);if(parsed.protocol!=="https:")throw new ServiceError(400,"INVALID_REQUEST");const id=crypto.randomUUID();const events=Array.isArray(value.events)?value.events.filter(item=>typeof item==="string"):[];await env.ADMIN_DB.prepare("INSERT INTO notification_targets (id,kind,name,url_ciphertext,events,created_at) VALUES (?1,?2,?3,?4,?5,?6)").bind(id,kind,requiredString(value.name,100),await sealSecret(env,targetUrl),JSON.stringify(events),Date.now()).run();await audit(env,actor,"notification.create","notification",id,{kind,events});return json({id,kind,configured:true},201);}

async function createEnrollment(env: WorkerEnv, actor: Actor): Promise<Response> {
  requirePermission(actor, "workers.manage");
  const token = randomSecret();
  await env.ADMIN_DB.prepare("INSERT INTO enrollment_tokens (token_hash, expires_at, created_by, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(await sha256(token), Date.now() + 10 * 60_000, actor.id, Date.now()).run();
  await audit(env, actor, "worker.enrollment.create", "worker", null);
  return json({ token, expires_at: Date.now() + 10 * 60_000 }, 201);
}

async function enrollWorker(env: WorkerEnv, value: Record<string, unknown>): Promise<Response> {
  const token = requiredString(value.token);
  const capabilities = value.capabilities as WorkerCapabilities | undefined;
  if (capabilities === undefined || typeof capabilities !== "object") throw new ServiceError(400, "INVALID_REQUEST");
  const enrollment = await env.ADMIN_DB.prepare("SELECT token_hash FROM enrollment_tokens WHERE token_hash=?1 AND used_at IS NULL AND expires_at>?2").bind(await sha256(token), Date.now()).first<{ token_hash: string }>();
  if (enrollment === null) throw new ServiceError(401, "UNAUTHORIZED");
  const workerId = capabilities.worker_id || crypto.randomUUID();
  const apiKey = randomSecret();
  const keyId = crypto.randomUUID();
  await env.ADMIN_DB.batch([
    env.ADMIN_DB.prepare("UPDATE enrollment_tokens SET used_at=?1 WHERE token_hash=?2").bind(Date.now(), enrollment.token_hash),
    env.ADMIN_DB.prepare(`INSERT INTO workers (id,name,version,backend,hardware,capabilities,self_test,production_ready,last_seen_at,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)`).bind(workerId, requiredString(value.name ?? workerId, 100), capabilities.version, capabilities.backend, capabilities.hardware, JSON.stringify(capabilities.capabilities), JSON.stringify(capabilities.self_test), capabilities.production_ready ? 1 : 0, Date.now()),
    env.ADMIN_DB.prepare("INSERT INTO service_keys (id,name,prefix,secret_hash,scopes,created_at) VALUES (?1,?2,?3,?4,?5,?6)").bind(keyId, `worker:${workerId}`, apiKey.slice(0, 13), await sha256(apiKey), JSON.stringify(["generator.jobs.read", "generator.events.write", "generator.candidates.write", "generator.artifacts.write", "workers.heartbeat"]), Date.now()),
  ]);
  await audit(env, null, "worker.enroll", "worker", workerId, { backend: capabilities.backend, production_ready: capabilities.production_ready });
  return json({ worker_id: workerId, api_key: apiKey }, 201);
}

async function collectorSubmit(env: WorkerEnv, actor: Actor, value: Record<string, unknown>): Promise<Response> {
  requirePermission(actor, "collector.submit");
  const recordingValue = value.recording;
  if (typeof recordingValue !== "object" || recordingValue === null || Array.isArray(recordingValue)) throw new ServiceError(400, "INVALID_REQUEST");
  const recording = recordingValue as Record<string, unknown>;
  const isrc = typeof recording.isrc === "string" && recording.isrc.length > 0 ? recording.isrc.replaceAll("-", "").toUpperCase() : null;
  const recordingId = crypto.randomUUID();
  const now = Date.now();
  const existing = isrc === null ? null : await env.ADMIN_DB.prepare("SELECT id FROM recordings WHERE isrc=?1").bind(isrc).first<{ id: string }>();
  const targetRecordingId = existing?.id ?? recordingId;
  if (existing === null) {
    await env.ADMIN_DB.prepare(`INSERT INTO recordings (id,isrc,mbid,artist,title,album,duration_ms,language,identification_state,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)`)
      .bind(targetRecordingId, isrc, typeof recording.mbid === "string" ? recording.mbid : null, requiredString(recording.artist, 500), requiredString(recording.title, 500), typeof recording.album === "string" ? recording.album : null, numberValue(recording.duration_ms, 1, 900_000), typeof recording.language === "string" ? recording.language : "und", isrc === null ? "pending" : "verified", now).run();
  }

  const sources = Array.isArray(value.sources) ? value.sources : [];
  let selectedSourceId: string | null = null;
  let selectedVideoId: string | null = null;
  for (const source of sources) {
    if (typeof source !== "object" || source === null || Array.isArray(source)) continue;
    const item = source as Record<string, unknown>;
    const id = crypto.randomUUID();
    const selected = item.selected === true && item.source_type !== "video";
    if (selected) selectedVideoId = requiredString(item.video_id,32);
    await env.ADMIN_DB.prepare(`INSERT OR IGNORE INTO media_sources (id,recording_id,url,video_id,rank,official,source_type,score,selected,metadata,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`)
      .bind(id, targetRecordingId, requiredString(item.url), requiredString(item.video_id, 32), numberValue(item.rank ?? 1, 1, 10), item.official === true ? 1 : 0, item.official === true ? "topic" : "unofficial", numberValue(item.score ?? 0, 0, 1), selected ? 1 : 0, JSON.stringify(item.metadata ?? {}), now).run();
    const stored=await env.ADMIN_DB.prepare("SELECT id FROM media_sources WHERE recording_id=?1 AND video_id=?2").bind(targetRecordingId,item.video_id).first<{id:string}>();
    if(selected&&stored!==null){selectedSourceId=stored.id;await env.ADMIN_DB.prepare("UPDATE media_sources SET selected=CASE WHEN id=?1 THEN 1 ELSE 0 END WHERE recording_id=?2").bind(stored.id,targetRecordingId).run();}
  }
  if (selectedSourceId === null) {
    const selected = await env.ADMIN_DB.prepare("SELECT id,video_id FROM media_sources WHERE recording_id=?1 AND selected=1 ORDER BY score DESC LIMIT 1").bind(targetRecordingId).first<{ id: string;video_id:string }>();
    selectedSourceId = selected?.id ?? null;
    selectedVideoId = selected?.video_id ?? null;
  }

  const lyrics = Array.isArray(value.lyrics) ? value.lyrics : [];
  const signatureParts=await Promise.all(lyrics.flatMap((item)=>typeof item==="object"&&item!==null&&!Array.isArray(item)?[sha256(`${String((item as Record<string,unknown>).provider??"")}\0${String((item as Record<string,unknown>).text??"")}`)]:[]));
  const inputSignature=await sha256(`${selectedVideoId??"none"}\0production-v1\0${signatureParts.sort().join("\0")}`);
  const duplicate=await env.ADMIN_DB.prepare("SELECT i.id,j.id job_id,j.state FROM input_revisions i LEFT JOIN jobs j ON j.input_revision_id=i.id WHERE i.recording_id=?1 AND i.input_signature=?2").bind(targetRecordingId,inputSignature).first<{id:string;job_id:string|null;state:string|null}>();
  if(duplicate!==null){await audit(env,actor,"collector.duplicate","input_revision",duplicate.id);return json({recording_id:targetRecordingId,input_revision_id:duplicate.id,job_id:duplicate.job_id,state:duplicate.state??"review_required",deduplicated:true});}
  const inputId = crypto.randomUUID();
  await env.ADMIN_DB.prepare("INSERT INTO input_revisions (id,recording_id,source_id,state,pipeline_profile,created_by,created_at,input_signature) VALUES (?1,?2,?3,?4,'production-v1',?5,?6,?7)")
    .bind(inputId, targetRecordingId, selectedSourceId, isrc !== null && selectedSourceId !== null ? "ready" : "draft", actor.id, now,inputSignature).run();
  for (const lyric of lyrics) {
    if (typeof lyric !== "object" || lyric === null || Array.isArray(lyric)) continue;
    const item = lyric as Record<string, unknown>;
    const raw = requiredString(item.text, 1_000_000);
    const provider = requiredString(item.provider, 100);
    const language = typeof item.language === "string" ? item.language : typeof recording.language === "string" ? recording.language : "und";
    const rawHash = await sha256(raw);
    await env.ADMIN_DB.prepare(`INSERT OR IGNORE INTO lyric_revisions (id,input_revision_id,provider,provider_ref,layer,language,text,text_hash,preprocessor,confidence,review_required,offset_map,rules,created_at) VALUES (?1,?2,?3,?4,'raw',?5,?6,?7,'raw-v1',1,0,'[]','[]',?8)`)
      .bind(crypto.randomUUID(), inputId, provider, typeof item.provider_ref === "string" ? item.provider_ref : null, language, raw, rawHash, now).run();
    const processed = preprocessLyrics(raw, language);
    for (const variant of processed.variants) {
      const tokenization = tokenizeV2(variant.text, variant.language);
      if (tokenization.tokens.length === 0) continue;
      await env.ADMIN_DB.prepare(`INSERT OR IGNORE INTO lyric_revisions (id,input_revision_id,provider,provider_ref,layer,language,text,text_hash,preprocessor,confidence,review_required,offset_map,rules,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`)
        .bind(crypto.randomUUID(), inputId, provider, typeof item.provider_ref === "string" ? item.provider_ref : null, variant.layer, variant.language, variant.text, textHash(tokenization.canonical), processed.version, variant.confidence, variant.review_required ? 1 : 0, JSON.stringify(variant.offset_map), JSON.stringify(variant.rules), now).run();
    }
  }

  let jobId: string | null = null;
  if (isrc !== null && selectedSourceId !== null) {
    jobId = crypto.randomUUID();
    await env.ADMIN_DB.prepare("INSERT INTO jobs (id,input_revision_id,state,priority,available_at,created_at,updated_at) VALUES (?1,?2,'queued',?3,?4,?4,?4)").bind(jobId, inputId, numberValue(value.priority ?? 0, -1_000_000, 1_000_000), now).run();
    await env.GENERATION_QUEUE.send(JSON.stringify({ schema_version: JOB_SCHEMA_VERSION, job_id: jobId, input_revision_id: inputId }), { contentType: "text" });
  }
  await audit(env, actor, "collector.submit", "input_revision", inputId, { recording_id: targetRecordingId, job_id: jobId, lyric_count: lyrics.length });
  await event(env, "collector.submitted", { recording_id: targetRecordingId, input_revision_id: inputId, job_id: jobId });
  return json({ recording_id: targetRecordingId, input_revision_id: inputId, job_id: jobId, state: jobId === null ? "review_required" : "queued" }, 201);
}

async function generatorJob(env: WorkerEnv, actor: Actor, jobId: string): Promise<Response> {
  requirePermission(actor, "generator.jobs.read");
  const row = await env.ADMIN_DB.prepare(`SELECT j.id job_id,j.input_revision_id,j.attempt_count,j.cancel_requested,r.*,s.url FROM jobs j JOIN input_revisions i ON i.id=j.input_revision_id JOIN recordings r ON r.id=i.recording_id JOIN media_sources s ON s.id=i.source_id WHERE j.id=?1`).bind(jobId).first<Record<string, unknown>>();
  if (row === null) throw new ServiceError(404, "NOT_FOUND");
  if (row.cancel_requested === 1) throw new ServiceError(409, "CANCELLED");
  const workerId = actor.id;
  const worker = await env.ADMIN_DB.prepare("SELECT id,production_ready,desired_state FROM workers WHERE id=(SELECT substr(name,8) FROM service_keys WHERE id=?1)").bind(workerId).first<{ id: string; production_ready: number; desired_state: string }>();
  const attemptId = crypto.randomUUID();
  await env.ADMIN_DB.batch([
    env.ADMIN_DB.prepare("UPDATE jobs SET state='claimed',attempt_count=attempt_count+1,worker_id=?1,updated_at=?2 WHERE id=?3 AND state IN ('queued','failed')").bind(worker?.id ?? actor.id, Date.now(), jobId),
    env.ADMIN_DB.prepare("INSERT INTO job_attempts (id,job_id,worker_id,state,started_at) VALUES (?1,?2,?3,'running',?4)").bind(attemptId, jobId, worker?.id ?? actor.id, Date.now()),
  ]);
  const lyrics = await env.ADMIN_DB.prepare("SELECT id,provider,provider_ref,language,text,preprocessor FROM lyric_revisions WHERE input_revision_id=?1 AND layer!='raw'").bind(String(row.input_revision_id)).all<Record<string, unknown>>();
  const alternatives = await env.ADMIN_DB.prepare("SELECT url FROM media_sources WHERE recording_id=?1 AND selected=0 ORDER BY rank LIMIT 2").bind(String(row.id)).all<{ url: string }>();
  const output: GeneratorJobInput = {
    schema_version: JOB_SCHEMA_VERSION,
    job_id: jobId,
    attempt_id: attemptId,
    input_revision_id: String(row.input_revision_id),
    recording: { isrc: String(row.isrc), ...(typeof row.mbid === "string" ? { mbid: row.mbid } : {}), artist: String(row.artist), title: String(row.title), ...(typeof row.album === "string" ? { album: row.album } : {}), duration_ms: Number(row.duration_ms), language: String(row.language) },
    source: { url: String(row.url), alternatives: alternatives.results.map((item) => item.url), max_duration_ms: 900_000 },
    lyrics: lyrics.results.map((item) => ({ id: String(item.id), provider: String(item.provider), ...(typeof item.provider_ref === "string" ? { provider_ref: item.provider_ref } : {}), language: String(item.language), text: String(item.text), preprocessing_version: String(item.preprocessor) })),
    pipeline: { version: "production-v1", profile: "production-v1" },
  };
  return json(output);
}

async function stageEvent(env: WorkerEnv, actor: Actor, value: Record<string, unknown>): Promise<Response> {
  requirePermission(actor, "generator.events.write");
  const item = value as unknown as StageEvent;
  const now = Date.now();
  await env.ADMIN_DB.batch([
    env.ADMIN_DB.prepare("INSERT INTO stage_events (job_id,attempt_id,stage,state,progress,code,metrics,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)").bind(item.job_id, item.attempt_id, item.stage, item.state, item.progress ?? null, item.code ?? null, JSON.stringify(item.metrics ?? {}), now),
    env.ADMIN_DB.prepare("UPDATE jobs SET state=?1,current_stage=?2,progress=?3,error_code=?4,updated_at=?5 WHERE id=?6").bind(item.state === "failed" ? "failed" : "running", item.stage, item.progress ?? (item.state === "completed" ? 1 : 0), item.code ?? null, now, item.job_id),
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
  if (submission.schema_version !== JOB_SCHEMA_VERSION || !Array.isArray(submission.alignments)) throw new ServiceError(400, "INVALID_REQUEST");
  const ids: string[] = [];
  const scores: Array<{id:string;score:number;language:number}> = [];
  for (const candidate of submission.alignments) {
    const id = crypto.randomUUID();
    ids.push(id);
    const score = qualityScore(candidate.quality);
    scores.push({id,score,language:candidate.quality.language_match??0});
    await env.ADMIN_DB.prepare(`INSERT INTO alignment_candidates (id,job_id,input_revision_id,variant_id,status,tokenizer,text_hash,fp_lens,fp_types,line_spans,word_spans,speaker_turns,word_speakers,line_speakers,quality,quality_score,pipeline_version,backend,hardware,created_by,created_at) VALUES (?1,?2,?3,?4,'pending',?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)`)
      .bind(id, submission.job_id, submission.input_revision_id, candidate.variant_id, candidate.tokenizer, candidate.text_hash, encode(candidate.fingerprint.lens), encode(candidate.fingerprint.types), encode(candidate.line_spans), encode(candidate.word_spans.map(([index,start,end]) => [index,start,end])), encode(candidate.speaker_turns), encode(candidate.word_speakers), encode(candidate.line_speakers), JSON.stringify(candidate.quality), score, submission.pipeline_version, submission.backend, submission.hardware, actor.id, Date.now()).run();
  }
  await env.ADMIN_DB.prepare("UPDATE jobs SET state='candidate_ready',progress=1,current_stage='candidate_submit',updated_at=?1 WHERE id=?2").bind(Date.now(), submission.job_id).run();
  await audit(env, actor, "candidate.submit", "job", submission.job_id, { candidate_ids: ids });
  await event(env, "candidate.ready", { job_id: submission.job_id, candidate_ids: ids });
  const settings=await env.ADMIN_DB.prepare("SELECT key,value FROM settings WHERE key IN ('auto_promotion_enabled','quality_threshold')").all<{key:string;value:string}>();const values=Object.fromEntries(settings.results.map(item=>[item.key,item.value]));let published=0;
  if(values.auto_promotion_enabled==="true"){
    const threshold=Number(values.quality_threshold??"0.9");const system:Actor={type:"service",id:"quality-gate",permissions:new Set(["*"])};
    for(const item of scores)if(item.score>=threshold&&item.language>=.9){await promote(env,system,item.id);published+=1;}
  }
  return json({ candidate_ids: ids, state: published===ids.length&&ids.length>0?"published":"review_required", published }, 201);
}

async function promote(env: WorkerEnv, actor: Actor, candidateId: string): Promise<Response> {
  requirePermission(actor, "candidates.approve");
  const row = await env.ADMIN_DB.prepare(`SELECT c.*,r.isrc,r.mbid,r.artist,r.title,r.duration_ms FROM alignment_candidates c JOIN input_revisions i ON i.id=c.input_revision_id JOIN recordings r ON r.id=i.recording_id WHERE c.id=?1`).bind(candidateId).first<Record<string, unknown>>();
  if (row === null) throw new ServiceError(404, "NOT_FOUND");
  const publicWrite = env.PUBLIC_DB.prepare(`INSERT INTO public_recording (isrc,mbid,artist_key,title_key,duration_ms) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(isrc) DO UPDATE SET mbid=COALESCE(excluded.mbid,public_recording.mbid),artist_key=excluded.artist_key,title_key=excluded.title_key,duration_ms=excluded.duration_ms`).bind(row.isrc, row.mbid ?? null, String(row.artist).normalize("NFKC").toLowerCase(), String(row.title).normalize("NFKC").toLowerCase(), row.duration_ms);
  const alignmentWrite = env.PUBLIC_DB.prepare(`INSERT INTO public_alignment (revision_id,isrc,text_hash,tokenizer,fp_lens,fp_types,line_spans,word_spans,speaker_turns,word_speakers,line_speakers,quality_score,source,active,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'manual',1,?13) ON CONFLICT(isrc,text_hash,tokenizer) DO UPDATE SET revision_id=excluded.revision_id,fp_lens=excluded.fp_lens,fp_types=excluded.fp_types,line_spans=excluded.line_spans,word_spans=excluded.word_spans,speaker_turns=excluded.speaker_turns,word_speakers=excluded.word_speakers,line_speakers=excluded.line_speakers,quality_score=excluded.quality_score,active=1,created_at=excluded.created_at`).bind(candidateId,row.isrc,row.text_hash,row.tokenizer,row.fp_lens,row.fp_types,row.line_spans,row.word_spans,row.speaker_turns,row.word_speakers,row.line_speakers,row.quality_score,Date.now());
  const results = await env.PUBLIC_DB.batch([publicWrite, alignmentWrite]);
  const publicId = Number(results[1]?.meta.last_row_id ?? 0);
  const releaseId = crypto.randomUUID();
  await env.ADMIN_DB.batch([
    env.ADMIN_DB.prepare("UPDATE alignment_candidates SET status='published' WHERE id=?1").bind(candidateId),
    env.ADMIN_DB.prepare("INSERT INTO releases (id,recording_id,candidate_id,public_alignment_id,state,policy_version,created_by,created_at) VALUES (?1,(SELECT recording_id FROM input_revisions WHERE id=?2),?3,?4,'active','manual-v1',?5,?6)").bind(releaseId,row.input_revision_id,candidateId,publicId,actor.id,Date.now()),
  ]);
  if(actor.type==="user"){
    const current=await env.ADMIN_DB.prepare("SELECT value FROM settings WHERE key='calibration_reviews'").first<{value:string}>();const count=Number(current?.value??0)+1;
    await env.ADMIN_DB.batch([
      env.ADMIN_DB.prepare("INSERT INTO settings (key,value,updated_by,updated_at) VALUES ('calibration_reviews',?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(String(count),actor.id,Date.now()),
      ...(count>=100?[env.ADMIN_DB.prepare("INSERT INTO settings (key,value,updated_by,updated_at) VALUES ('auto_promotion_enabled','true',?1,?2) ON CONFLICT(key) DO UPDATE SET value='true',updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(actor.id,Date.now())]:[]),
    ]);
  }
  await audit(env, actor, "release.promote", "candidate", candidateId, { release_id: releaseId });
  await event(env, "release.published", { candidate_id: candidateId, release_id: releaseId });
  return json({ release_id: releaseId, public_alignment_id: publicId }, 201);
}

async function withdrawRelease(env:WorkerEnv,actor:Actor,releaseId:string):Promise<Response>{requirePermission(actor,"releases.unpublish");const release=await env.ADMIN_DB.prepare("SELECT candidate_id FROM releases WHERE id=?1 AND state='active'").bind(releaseId).first<{candidate_id:string}>();if(release===null)throw new ServiceError(404,"NOT_FOUND");await env.PUBLIC_DB.prepare("UPDATE public_alignment SET active=0 WHERE revision_id=?1").bind(release.candidate_id).run();await env.ADMIN_DB.batch([env.ADMIN_DB.prepare("UPDATE releases SET state='withdrawn' WHERE id=?1").bind(releaseId),env.ADMIN_DB.prepare("UPDATE alignment_candidates SET status='withdrawn' WHERE id=?1").bind(release.candidate_id)]);await audit(env,actor,"release.withdraw","release",releaseId);await event(env,"release.withdrawn",{release_id:releaseId});return json({release_id:releaseId,state:"withdrawn"});}

async function candidateDetail(env: WorkerEnv, actor: Actor, candidateId: string): Promise<Response> {
  requirePermission(actor, "candidates.read");
  const candidate = await env.ADMIN_DB.prepare(`SELECT c.*,l.text lyric_text FROM alignment_candidates c JOIN lyric_revisions l ON l.id=c.variant_id WHERE c.id=?1`).bind(candidateId).first<Record<string, unknown>>();
  if (candidate === null) throw new ServiceError(404, "NOT_FOUND");
  const artifacts = await env.ADMIN_DB.prepare("SELECT id,kind,speaker_id,content_type,byte_size FROM artifacts WHERE job_id=?1 AND deleted_at IS NULL ORDER BY kind,speaker_id").bind(candidate.job_id).all<Record<string, unknown>>();
  return json({ id: candidate.id, lyric_text: candidate.lyric_text, line_spans: decode(candidate.line_spans as ArrayBuffer), word_spans: decode(candidate.word_spans as ArrayBuffer), speaker_turns: decode(candidate.speaker_turns as ArrayBuffer), word_speakers: decode(candidate.word_speakers as ArrayBuffer), line_speakers: decode(candidate.line_speakers as ArrayBuffer), quality: JSON.parse(String(candidate.quality)), artifacts: artifacts.results });
}

async function acquireLease(env: WorkerEnv, actor: Actor, candidateId: string, force: boolean): Promise<Response> {
  requirePermission(actor, "timing.edit");
  const existing = await env.ADMIN_DB.prepare("SELECT user_id,expires_at FROM edit_leases WHERE candidate_id=?1").bind(candidateId).first<{ user_id: string; expires_at: number }>();
  if (existing !== null && existing.expires_at > Date.now() && existing.user_id !== actor.id && !force) throw new ServiceError(423, "EDIT_LOCKED");
  if (existing !== null && existing.user_id !== actor.id && force) requirePermission(actor, "timing.lease.force");
  await env.ADMIN_DB.prepare("INSERT INTO edit_leases (candidate_id,user_id,expires_at,updated_at) VALUES (?1,?2,?3,?4) ON CONFLICT(candidate_id) DO UPDATE SET user_id=excluded.user_id,expires_at=excluded.expires_at,updated_at=excluded.updated_at").bind(candidateId, actor.id, Date.now()+10*60_000, Date.now()).run();
  await audit(env, actor, existing !== null && existing.user_id !== actor.id ? "edit.lease.force" : "edit.lease.acquire", "candidate", candidateId);
  return json({ candidate_id: candidateId, holder: actor.id, expires_at: Date.now()+10*60_000 });
}

function validDraft(value: Record<string, unknown>): boolean {
  const lines = value.line_spans;
  const words = value.word_spans;
  if (!Array.isArray(lines) || !Array.isArray(words)) return false;
  let previous = 0;
  for (const row of lines) {
    if (!Array.isArray(row) || row.length !== 2 || row.some((item) => typeof item !== "number") || Number(row[0]) < previous || Number(row[1]) <= Number(row[0])) return false;
    previous = Number(row[1]);
  }
  previous = 0;
  for (const row of words) {
    if (!Array.isArray(row) || row.length < 3 || row.some((item, index) => index < 3 && typeof item !== "number") || Number(row[1]) < previous || Number(row[2]) <= Number(row[1])) return false;
    previous = Number(row[2]);
  }
  return true;
}

async function saveDraft(env: WorkerEnv, actor: Actor, candidateId: string, value: Record<string, unknown>): Promise<Response> {
  requirePermission(actor, "timing.edit");
  const lease = await env.ADMIN_DB.prepare("SELECT user_id,expires_at FROM edit_leases WHERE candidate_id=?1").bind(candidateId).first<{ user_id: string; expires_at: number }>();
  if (lease === null || lease.user_id !== actor.id || lease.expires_at < Date.now()) throw new ServiceError(423, "EDIT_LOCKED");
  const valid = validDraft(value);
  await env.ADMIN_DB.batch([
    env.ADMIN_DB.prepare("INSERT INTO draft_edits (candidate_id,user_id,data,valid,updated_at) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(candidate_id,user_id) DO UPDATE SET data=excluded.data,valid=excluded.valid,updated_at=excluded.updated_at").bind(candidateId,actor.id,JSON.stringify(value),valid?1:0,Date.now()),
    env.ADMIN_DB.prepare("UPDATE edit_leases SET expires_at=?1,updated_at=?2 WHERE candidate_id=?3").bind(Date.now()+10*60_000,Date.now(),candidateId),
  ]);
  return json({ saved: true, valid });
}

async function submitDraft(env: WorkerEnv, actor: Actor, candidateId: string): Promise<Response> {
  requirePermission(actor, "timing.edit");
  const draft = await env.ADMIN_DB.prepare("SELECT data,valid FROM draft_edits WHERE candidate_id=?1 AND user_id=?2").bind(candidateId,actor.id).first<{ data: string; valid: number }>();
  if (draft === null) throw new ServiceError(404, "NOT_FOUND");
  if (draft.valid !== 1) throw new ServiceError(409, "INVALID_DRAFT");
  const source = await env.ADMIN_DB.prepare("SELECT * FROM alignment_candidates WHERE id=?1").bind(candidateId).first<Record<string, unknown>>();
  if (source === null) throw new ServiceError(404, "NOT_FOUND");
  const data = JSON.parse(draft.data) as Record<string, unknown>;
  const id = crypto.randomUUID();
  await env.ADMIN_DB.batch([
    env.ADMIN_DB.prepare(`INSERT INTO alignment_candidates (id,job_id,input_revision_id,variant_id,parent_id,status,tokenizer,text_hash,fp_lens,fp_types,line_spans,word_spans,speaker_turns,word_speakers,line_speakers,quality,quality_score,pipeline_version,backend,hardware,created_by,created_at) VALUES (?1,?2,?3,?4,?5,'pending',?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)`).bind(id,source.job_id,source.input_revision_id,source.variant_id,candidateId,source.tokenizer,source.text_hash,source.fp_lens,source.fp_types,encode(data.line_spans),encode(data.word_spans),source.speaker_turns,source.word_speakers,source.line_speakers,source.quality,source.quality_score,source.pipeline_version,source.backend,source.hardware,actor.id,Date.now()),
    env.ADMIN_DB.prepare("DELETE FROM draft_edits WHERE candidate_id=?1 AND user_id=?2").bind(candidateId,actor.id),
    env.ADMIN_DB.prepare("DELETE FROM edit_leases WHERE candidate_id=?1").bind(candidateId),
  ]);
  await audit(env, actor, "candidate.revise", "candidate", id, { parent_id: candidateId });
  await event(env, "candidate.revised", { candidate_id: id, parent_id: candidateId });
  return json({ candidate_id: id }, 201);
}

async function jobAction(env: WorkerEnv, actor: Actor, jobId: string, action: string): Promise<Response> {
  requirePermission(actor, "jobs.manage");
  const now = Date.now();
  if (action === "cancel") await env.ADMIN_DB.prepare("UPDATE jobs SET cancel_requested=1,state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END,updated_at=?1 WHERE id=?2").bind(now, jobId).run();
  else if (action === "retry") {
    const row = await env.ADMIN_DB.prepare("SELECT input_revision_id,attempt_count,max_attempts FROM jobs WHERE id=?1").bind(jobId).first<{ input_revision_id: string; attempt_count: number; max_attempts: number }>();
    if (row === null) throw new ServiceError(404, "NOT_FOUND");
    if (row.attempt_count >= row.max_attempts) throw new ServiceError(409, "ATTEMPT_LIMIT");
    await env.ADMIN_DB.prepare("UPDATE jobs SET state='queued',cancel_requested=0,error_code=NULL,available_at=?1,updated_at=?1 WHERE id=?2").bind(now, jobId).run();
    await env.GENERATION_QUEUE.send(JSON.stringify({ schema_version: JOB_SCHEMA_VERSION, job_id: jobId, input_revision_id: row.input_revision_id }), { contentType: "text" });
  } else throw new ServiceError(404, "NOT_FOUND");
  await audit(env, actor, `job.${action}`, "job", jobId);
  await event(env, `job.${action}`, { job_id: jobId });
  return json({ job_id: jobId, action }, 202);
}

async function registerArtifact(env: WorkerEnv, actor: Actor, value: Record<string, unknown>): Promise<Response> {
  requirePermission(actor, "generator.artifacts.write");
  const id = crypto.randomUUID();
  const r2Key = `jobs/${requiredString(value.job_id, 64)}/${id}`;
  await env.ADMIN_DB.prepare(`INSERT INTO artifacts (id,job_id,kind,speaker_id,r2_key,content_type,byte_size,sha256,encryption,wrapped_key,chunk_size,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`)
    .bind(id,value.job_id,requiredString(value.kind,50),typeof value.speaker_id === "number" ? value.speaker_id : null,r2Key,requiredString(value.content_type,100),numberValue(value.byte_size),requiredString(value.sha256,128),requiredString(value.encryption,100),requiredString(value.wrapped_key,4096),numberValue(value.chunk_size,1),Date.now()).run();
  return json({ artifact_id: id, upload_path: `/admin/api/generator/artifacts/${id}/content` }, 201);
}

async function artifactContent(request: Request, env: WorkerEnv, actor: Actor, artifactId: string): Promise<Response> {
  const row = await env.ADMIN_DB.prepare("SELECT r2_key,content_type,byte_size,wrapped_key,chunk_size,encryption FROM artifacts WHERE id=?1 AND deleted_at IS NULL").bind(artifactId).first<{ r2_key: string; content_type: string; byte_size: number; wrapped_key:string;chunk_size:number;encryption:string }>();
  if (row === null) throw new ServiceError(404, "NOT_FOUND");
  if (request.method === "PUT") {
    requirePermission(actor, "generator.artifacts.write");
    await env.ADMIN_ARTIFACTS.put(row.r2_key, request.body, { httpMetadata: { contentType: "application/octet-stream" }, customMetadata: { artifactId } });
    return new Response(null, { status: 204 });
  }
  requirePermission(actor, "artifacts.read");
  return serveArtifact(request,env,row);
}

async function workerHeartbeat(env: WorkerEnv, actor: Actor, value: Record<string, unknown>): Promise<Response> {
  requirePermission(actor, "workers.heartbeat");
  const workerId = requiredString(value.worker_id, 100);
  await env.ADMIN_DB.prepare("UPDATE workers SET last_seen_at=?1,version=?2,desired_state=desired_state WHERE id=?3").bind(Date.now(), requiredString(value.version, 100), workerId).run();
  const state = await env.ADMIN_DB.prepare("SELECT desired_state FROM workers WHERE id=?1").bind(workerId).first<{ desired_state: string }>();
  return json({ desired_state: state?.desired_state ?? "paused", server_time: Date.now() });
}

async function dispatchNotifications(env: WorkerEnv, type: string, data: Record<string, unknown>): Promise<void> {
  if (!["job.failed", "worker.offline", "queue.backlog", "canary.regression", "auth.anomaly"].includes(type)) return;
  const targets = await env.ADMIN_DB.prepare("SELECT kind,url_ciphertext FROM notification_targets WHERE enabled=1").all<{ kind: string; url_ciphertext: string }>();
  const timeoutMs = Number(await runtimeValue(env, "server.notification_timeout_ms") ?? 5000);
  await Promise.all(targets.results.map(async (target) => {
    try {
      const targetUrl=await openSecret(env,target.url_ciphertext);if(!targetUrl.startsWith("https://"))return;
      const payload = target.kind === "discord" ? { embeds: [{ title: `Mora: ${type}`, description: "관리자 확인이 필요합니다.", color: 0xe0a84b, fields: Object.entries(data).slice(0, 10).map(([name, value]) => ({ name, value: String(value), inline: true })), timestamp: new Date().toISOString() }] } : { type, data, at: Date.now() };
      const serialized = JSON.stringify(payload);
      const headers: Record<string,string> = { "content-type": "application/json" };
      if (target.kind === "webhook") {
        const signature = await webhookSignature(env, serialized);
        if (signature !== undefined) headers["X-Mora-Signature"] = signature;
      }
      await fetch(targetUrl, { method: "POST", headers, body: serialized, signal: AbortSignal.timeout(timeoutMs) });
    } catch { /* diagnostic only; never include secrets */ }
  }));
}

export async function handleAdmin(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/admin/api/auth/status") {
    const count = await env.ADMIN_DB.prepare("SELECT COUNT(*) count FROM webauthn_credentials").first<{ count: number }>();
    try { return json({ bootstrapped: (count?.count ?? 0) > 0, actor: actorJson(await authenticate(request, env)) }); }
    catch { return json({ bootstrapped: (count?.count ?? 0) > 0, actor: null }); }
  }
  if (request.method === "POST" && url.pathname === "/admin/api/auth/bootstrap/options") return json(await bootstrapOptions(request, env, await body(request)));
  if (request.method === "POST" && url.pathname === "/admin/api/auth/bootstrap/verify") { const result = await bootstrapVerify(request, env, await body(request)); return json({ user_id: result.user_id }, 201, { "Set-Cookie": result.cookie }); }
  if (request.method === "POST" && url.pathname === "/admin/api/auth/login/options") return json(await loginOptions(request, env, await body(request)));
  if (request.method === "POST" && url.pathname === "/admin/api/auth/login/verify") { const result = await loginVerify(request, env, await body(request)); return json({ user_id: result.user_id }, 200, { "Set-Cookie": result.cookie }); }
  if (request.method === "POST" && url.pathname === "/admin/api/auth/logout") return json({ ok: true }, 200, { "Set-Cookie": await logout(request, env) });
  if (request.method === "POST" && url.pathname === "/admin/api/generator/enroll") return enrollWorker(env, await body(request));

  const actor = await authenticate(request, env);
  if (request.method === "GET" && url.pathname === "/admin/api/events") {
    requirePermission(actor, "dashboard.read");
    return env.ADMIN_EVENTS.get(env.ADMIN_EVENTS.idFromName("global")).fetch("https://events.internal/subscribe");
  }
  if (request.method === "GET" && url.pathname === "/admin/api/overview") { requirePermission(actor, "dashboard.read"); return json(await overview(env)); }
  if (request.method === "GET" && url.pathname === "/admin/api/jobs") { requirePermission(actor, "jobs.read"); return json({ items: await list(env.ADMIN_DB, "SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200") }); }
  if (request.method === "GET" && url.pathname === "/admin/api/workers") { requirePermission(actor, "workers.read"); return json({ items: await list(env.ADMIN_DB, "SELECT id,name,version,backend,hardware,capabilities,self_test,production_ready,desired_state,last_seen_at,created_at FROM workers ORDER BY last_seen_at DESC") }); }
  if (request.method === "GET" && url.pathname === "/admin/api/recordings") { requirePermission(actor, "recordings.read"); return json({ items: await list(env.ADMIN_DB, "SELECT * FROM recordings ORDER BY created_at DESC LIMIT 200") }); }
  if (request.method === "GET" && url.pathname === "/admin/api/candidates") { requirePermission(actor, "candidates.read"); return json({ items: await list(env.ADMIN_DB, "SELECT id,job_id,input_revision_id,variant_id,status,tokenizer,text_hash,quality,quality_score,pipeline_version,backend,hardware,created_at FROM alignment_candidates ORDER BY created_at DESC LIMIT 200") }); }
  if (request.method === "GET" && url.pathname === "/admin/api/audit") { requirePermission(actor, "audit.read"); return json({ items: await list(env.ADMIN_DB, "SELECT * FROM audit_log ORDER BY id DESC LIMIT 500") }); }
  if (request.method === "GET" && url.pathname === "/admin/api/releases") { requirePermission(actor, "releases.read"); return json({items:await list(env.ADMIN_DB,"SELECT * FROM releases ORDER BY created_at DESC LIMIT 500")}); }
  if (request.method === "GET" && url.pathname === "/admin/api/roles") { requirePermission(actor,"roles.read");return json({items:await list(env.ADMIN_DB,"SELECT id,name,permissions,system,created_at FROM roles ORDER BY name")}); }
  if (request.method === "GET" && url.pathname === "/admin/api/settings") return listRuntimeConfig(env, actor);
  if (request.method === "POST" && url.pathname === "/admin/api/service-keys") return createServiceKey(env, actor, await body(request));
  if (request.method === "POST" && url.pathname === "/admin/api/roles") return upsertRole(env,actor,await body(request));
  if (request.method === "POST" && url.pathname === "/admin/api/notifications") return addNotification(env,actor,await body(request));
  if (request.method === "POST" && url.pathname === "/admin/api/workers/enrollment") return createEnrollment(env, actor);
  if (request.method === "POST" && url.pathname === "/admin/api/collector/recordings") return collectorSubmit(env, actor, await body(request));
  if (request.method === "POST" && url.pathname === "/admin/api/generator/events") return stageEvent(env, actor, await body(request));
  if (request.method === "POST" && url.pathname === "/admin/api/generator/candidates") return submitCandidates(env, actor, await body(request));
  if (request.method === "POST" && url.pathname === "/admin/api/generator/artifacts") return registerArtifact(env, actor, await body(request));
  if (request.method === "POST" && url.pathname === "/admin/api/generator/heartbeat") return workerHeartbeat(env, actor, await body(request));

  let match = url.pathname.match(/^\/admin\/api\/generator\/jobs\/([^/]+)$/u);
  if (request.method === "GET" && match?.[1] !== undefined) return generatorJob(env, actor, match[1]);
  match = url.pathname.match(/^\/admin\/api\/generator\/artifacts\/([^/]+)\/content$/u);
  if ((request.method === "PUT" || request.method === "GET") && match?.[1] !== undefined) return artifactContent(request, env, actor, match[1]);
  match = url.pathname.match(/^\/admin\/api\/jobs\/([^/]+)\/(retry|cancel)$/u);
  if (request.method === "POST" && match?.[1] !== undefined && match[2] !== undefined) return jobAction(env, actor, match[1], match[2]);
  match = url.pathname.match(/^\/admin\/api\/candidates\/([^/]+)\/approve$/u);
  if (request.method === "POST" && match?.[1] !== undefined) return promote(env, actor, match[1]);
  match = url.pathname.match(/^\/admin\/api\/candidates\/([^/]+)$/u);
  if (request.method === "GET" && match?.[1] !== undefined) return candidateDetail(env, actor, match[1]);
  match = url.pathname.match(/^\/admin\/api\/candidates\/([^/]+)\/lease$/u);
  if (request.method === "POST" && match?.[1] !== undefined) return acquireLease(env, actor, match[1], url.searchParams.get("force") === "1");
  match = url.pathname.match(/^\/admin\/api\/candidates\/([^/]+)\/draft$/u);
  if (request.method === "PUT" && match?.[1] !== undefined) return saveDraft(env, actor, match[1], await body(request));
  match = url.pathname.match(/^\/admin\/api\/candidates\/([^/]+)\/submit-draft$/u);
  if (request.method === "POST" && match?.[1] !== undefined) return submitDraft(env, actor, match[1]);
  match=url.pathname.match(/^\/admin\/api\/users\/([^/]+)\/roles$/u);if(request.method==="POST"&&match?.[1]!==undefined)return assignRole(env,actor,match[1],await body(request));
  match=url.pathname.match(/^\/admin\/api\/settings\/([^/]+)$/u);
  if(request.method==="PUT"&&match?.[1]!==undefined)return putRuntimeConfig(env,actor,decodeURIComponent(match[1]),await body(request));
  if(request.method==="DELETE"&&match?.[1]!==undefined)return deleteRuntimeConfig(env,actor,decodeURIComponent(match[1]));
  match=url.pathname.match(/^\/admin\/api\/releases\/([^/]+)\/withdraw$/u);if(request.method==="POST"&&match?.[1]!==undefined)return withdrawRelease(env,actor,match[1]);
  throw new ServiceError(404, "NOT_FOUND");
}
