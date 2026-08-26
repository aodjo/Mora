import { serializeOutput } from "../../packages/core/src/api/formats.js";
import { AlignmentService } from "../../packages/core/src/service.js";
import { ServiceError } from "../../packages/core/src/shared/errors.js";
import { handleAdmin } from "./admin/api.js";
import { runtimeValue } from "./admin/runtime-config.js";
import { D1AlignmentStore } from "./d1-store.js";
import type { WorkerEnv } from "./env.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
// Audit rows are kept indefinitely; stage events are diagnostics and expire after 30 days.
const DIAGNOSTIC_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// 소리는 검수를 위해 올린다. 그 일이 끝나면 다시 열리지 않는데, 지우는 코드가 한 줄도
// 없어 곡마다 스무 남짓 메가바이트가 영영 남았다 — 한창 돌 때 시간당 2GiB 씩 늘었다.
// 정렬 결과와 진단(파형·체크포인트·전사)은 작고 오래 쓸모가 있으니 남기고, 다시 듣지
// 않을 소리만 거둔다. 2주는 사람이 한 곡을 다시 들여다볼 만한 시간이다.
const AUDIO_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
// 한 번에 거두는 양. 크론이 하루 한 번 도는데, 이보다 많이 쌓이면 다음 날이 이어받는다.
const RECLAIM_LIMIT = 2000;
const RECLAIM_CHUNK = 500;
const securityHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
} as const;

const publicCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
} as const;

function json(value: unknown, status = 200, cors = false): Response {
  return Response.json(value, { status, headers: { ...securityHeaders, ...(cors ? publicCors : {}) } });
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== null && contentType !== undefined && contentType !== "application/json")
    throw new ServiceError(400, "INVALID_REQUEST");
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) throw new ServiceError(413, "PAYLOAD_TOO_LARGE");
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) throw new ServiceError(413, "PAYLOAD_TOO_LARGE");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ServiceError(400, "BAD_JSON");
  }
}

async function publicRoute(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const service = new AlignmentService(new D1AlignmentStore(env.PUBLIC_DB));
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: publicCors });
  if (request.method === "GET" && url.pathname === "/health") return json({ status: "ok" }, 200, true);
  if (request.method === "GET" && url.pathname === "/v1/dump") {
    const external = await runtimeValue(env, "server.dump_url");
    if (external !== undefined) return Response.redirect(external, 302);
    if (env.DUMP_URL !== undefined) return Response.redirect(env.DUMP_URL, 302);
    const object = await env.PUBLIC_DUMPS.get("mora-public.sqlite");
    if (object === null) throw new ServiceError(503, "DUMP_NOT_READY");
    const headers = new Headers({
      ...securityHeaders,
      ...publicCors,
      "Content-Disposition": "attachment; filename=mora-public.sqlite",
      "Content-Length": String(object.size),
      "Content-Type": "application/vnd.sqlite3",
      ETag: object.httpEtag,
    });
    object.writeHttpMetadata(headers);
    return new Response(object.body, { headers });
  }
  if (request.method !== "POST") throw new ServiceError(404, "NOT_FOUND");
  if (url.pathname === "/v1/align") {
    const result = await service.align(await readJson(request));
    const output = serializeOutput(result, url.searchParams.get("format"));
    return new Response(output.body, { status: 200, headers: { ...securityHeaders, ...publicCors, "Content-Type": output.contentType } });
  }
  if (url.pathname === "/v1/align/fingerprint") return json(await service.alignFingerprint(await readJson(request)), 200, true);
  if (url.pathname === "/v1/tokenize") return json(service.tokenize(await readJson(request)), 200, true);
  throw new ServiceError(404, "NOT_FOUND");
}

async function adminAsset(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const assetPath = url.pathname.slice("/admin".length);
  url.pathname = assetPath.length === 0 || assetPath === "/" ? "/" : assetPath;
  const htmlRoute = url.pathname === "/" || !/\.[^/]+$/u.test(url.pathname);
  if (htmlRoute) url.searchParams.set("__mora_html", String(Date.now()));
  const response = await env.ASSETS.fetch(new Request(url, request));
  const headers = new Headers(response.headers);
  if (response.headers.get("content-type")?.includes("text/html") === true) headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  headers.set(
    "Permissions-Policy",
    "camera=(), geolocation=(), microphone=(), publickey-credentials-create=(self), publickey-credentials-get=(self)",
  );
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function route(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/admin/api/")) return handleAdmin(request, env);
  if (url.pathname === "/admin") return Response.redirect(`${url.origin}/admin/`, 308);
  if (url.pathname.startsWith("/admin/")) return adminAsset(request, env);
  return publicRoute(request, env);
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      const url = new URL(request.url);
      if (error instanceof ServiceError) return json({ error: error.code }, error.status, url.pathname.startsWith("/v1/"));
      // Never log request bodies, caught values, or stacks: they can retain lyrics or credentials.
      // The route and the error's kind carry none of that, and without them a 500 is a dead end —
      // the client is told INTERNAL and nothing anywhere says which handler failed.
      console.error(`unhandled ${error instanceof Error ? error.name : typeof error} at ${request.method} ${url.pathname}`);
      return json({ error: "INTERNAL" }, 500, url.pathname.startsWith("/v1/"));
    }
  },
  async scheduled(_controller: ScheduledController, env: WorkerEnv): Promise<void> {
    const now = Date.now();
    // Rows whose whole purpose has a deadline. Nothing reads them once it passes, but only
    // the pairing tables swept themselves, so the rest grew for the life of the deployment.
    await env.ADMIN_DB.batch([
      env.ADMIN_DB.prepare("DELETE FROM stage_events WHERE created_at < ?1").bind(now - DIAGNOSTIC_RETENTION_MS),
      env.ADMIN_DB.prepare("DELETE FROM sessions WHERE expires_at < ?1").bind(now),
      env.ADMIN_DB.prepare("DELETE FROM auth_challenges WHERE expires_at < ?1").bind(now),
      env.ADMIN_DB.prepare("DELETE FROM enrollment_tokens WHERE used_at IS NOT NULL OR expires_at < ?1").bind(now),
      env.ADMIN_DB.prepare("DELETE FROM edit_leases WHERE expires_at < ?1").bind(now),
      env.ADMIN_DB.prepare("DELETE FROM collector_pairings WHERE expires_at < ?1").bind(now),
      env.ADMIN_DB.prepare("DELETE FROM generator_pairings WHERE expires_at < ?1").bind(now),
    ]);
    await reclaimAudio(env, now);
  },
} satisfies ExportedHandler<WorkerEnv>;

/**
 * Give back the space held by audio nobody will listen to again.
 *
 * Every read path already asks for `deleted_at IS NULL`, so marking the row is enough to make
 * the artifact disappear from the console; the object is what costs money, and that goes first.
 * If the worker dies between the two, the row is still there and the next run tries again —
 * the other order would leave objects no row remembers, which nothing could ever find to delete.
 */
async function reclaimAudio(env: WorkerEnv, now: number): Promise<void> {
  const stale = await env.ADMIN_DB.prepare(
    `SELECT id,r2_key FROM artifacts
     WHERE deleted_at IS NULL AND content_type LIKE 'audio/%' AND created_at < ?1
     ORDER BY created_at LIMIT ?2`,
  )
    .bind(now - AUDIO_RETENTION_MS, RECLAIM_LIMIT)
    .all<{ id: string; r2_key: string }>();
  for (let start = 0; start < stale.results.length; start += RECLAIM_CHUNK) {
    const batch = stale.results.slice(start, start + RECLAIM_CHUNK);
    await env.ADMIN_ARTIFACTS.delete(batch.map((row) => row.r2_key));
    await env.ADMIN_DB.prepare(`UPDATE artifacts SET deleted_at=?1 WHERE id IN (${batch.map(() => "?").join(",")})`)
      .bind(now, ...batch.map((row) => row.id))
      .run();
  }
}
