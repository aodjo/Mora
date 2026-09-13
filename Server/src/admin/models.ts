import type { WorkerEnv } from "../env.js";
import { ServiceError } from "../../../packages/core/src/shared/errors.js";
import { audit, requirePermission, type Actor } from "./auth.js";

/** Model files are plain objects under this prefix of the private artifact bucket. */
const PREFIX = "models/";
/** Only lowercase letters, digits, dot, dash and underscore — the name becomes an R2 key. */
const NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
/**
 * Largest part a request may carry. A Worker takes at most 100 MB of request body, so a model of
 * a gigabyte or more cannot be sent in one request; it goes up in parts of this size and R2 joins
 * them. R2 wants every part but the last to be the same size.
 */
export const MODEL_PART_BYTES = 90 * 1024 * 1024;

const jsonHeaders = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" } as const;

/**
 * Answer with a JSON body.
 *
 * @param {unknown} value - The body.
 * @param {number} [status=200] - HTTP status.
 * @returns {Response} The response.
 */
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: jsonHeaders });
}

/**
 * Turn a model name from the path into its R2 key, refusing anything that is not a plain name.
 *
 * @param {string} name - The model name, e.g. `mms_sing_b.pt`.
 * @returns {string} The R2 key.
 * @throws {ServiceError} 400 when the name is not plain.
 */
function keyOf(name: string): string {
  if (!NAME.test(name)) throw new ServiceError(400, "INVALID_REQUEST");
  return `${PREFIX}${name}`;
}

/**
 * Begin uploading a model file in parts.
 *
 * The caller states the file's size and SHA-256 up front; they are kept on the object so a worker
 * can check what it downloaded against them.
 *
 * @param {WorkerEnv} env - Bindings.
 * @param {Actor} actor - Who is asking; needs `workers.manage`.
 * @param {string} name - The model name.
 * @param {Record<string, unknown>} value - `{ byte_size, sha256 }`.
 * @returns {Promise<Response>} `{ upload_id, part_bytes }`.
 */
export async function startModelUpload(env: WorkerEnv, actor: Actor, name: string, value: Record<string, unknown>): Promise<Response> {
  requirePermission(actor, "workers.manage");
  const size = Number(value.byte_size);
  const digest = String(value.sha256 ?? "");
  if (!Number.isSafeInteger(size) || size <= 0 || !/^[0-9a-f]{64}$/u.test(digest)) throw new ServiceError(400, "INVALID_REQUEST");
  const upload = await env.ADMIN_ARTIFACTS.createMultipartUpload(keyOf(name), {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { sha256: digest, byte_size: String(size) },
  });
  await audit(env, actor, "model.upload.start", "model", name, { byte_size: size, sha256: digest });
  return json({ upload_id: upload.uploadId, part_bytes: MODEL_PART_BYTES }, 201);
}

/**
 * Store one part of a model upload.
 *
 * @param {Request} request - Its body is the part.
 * @param {WorkerEnv} env - Bindings.
 * @param {Actor} actor - Who is asking; needs `workers.manage`.
 * @param {string} name - The model name.
 * @param {string} uploadId - From `startModelUpload`.
 * @param {number} part - Part number, from 1.
 * @returns {Promise<Response>} `{ part_number, etag }`, which `completeModelUpload` needs back.
 */
export async function uploadModelPart(
  request: Request,
  env: WorkerEnv,
  actor: Actor,
  name: string,
  uploadId: string,
  part: number,
): Promise<Response> {
  requirePermission(actor, "workers.manage");
  if (!Number.isInteger(part) || part < 1 || part > 10_000 || request.body === null) throw new ServiceError(400, "INVALID_REQUEST");
  const upload = env.ADMIN_ARTIFACTS.resumeMultipartUpload(keyOf(name), uploadId);
  const stored = await upload.uploadPart(part, request.body);
  return json({ part_number: stored.partNumber, etag: stored.etag });
}

/**
 * Join the parts of a model upload into one object.
 *
 * @param {WorkerEnv} env - Bindings.
 * @param {Actor} actor - Who is asking; needs `workers.manage`.
 * @param {string} name - The model name.
 * @param {string} uploadId - From `startModelUpload`.
 * @param {Record<string, unknown>} value - `{ parts: [{ part_number, etag }] }`.
 * @returns {Promise<Response>} `{ name, byte_size }`.
 */
export async function completeModelUpload(
  env: WorkerEnv,
  actor: Actor,
  name: string,
  uploadId: string,
  value: Record<string, unknown>,
): Promise<Response> {
  requirePermission(actor, "workers.manage");
  const parts = Array.isArray(value.parts) ? value.parts : [];
  const uploaded = parts.map((one) => {
    const row = one as Record<string, unknown>;
    return { partNumber: Number(row.part_number), etag: String(row.etag ?? "") };
  });
  if (!uploaded.length || uploaded.some((one) => !Number.isInteger(one.partNumber) || !one.etag))
    throw new ServiceError(400, "INVALID_REQUEST");
  const upload = env.ADMIN_ARTIFACTS.resumeMultipartUpload(keyOf(name), uploadId);
  const object = await upload.complete(uploaded);
  await audit(env, actor, "model.upload.complete", "model", name, { byte_size: object.size });
  return json({ name, byte_size: object.size });
}

/**
 * Hand a model file to a worker, honouring a byte range so an interrupted download can resume.
 *
 * Workers already hold `generator.jobs.read`: whoever may take a job may fetch what the job needs.
 * The size and SHA-256 given at upload come back as headers so the worker can check the file.
 *
 * @param {Request} request - May carry `Range: bytes=start-`; `HEAD` asks for the headers only.
 * @param {WorkerEnv} env - Bindings.
 * @param {Actor} actor - Who is asking; needs `generator.jobs.read`.
 * @param {string} name - The model name.
 * @returns {Promise<Response>} The file, or the requested part of it.
 */
export async function serveModel(request: Request, env: WorkerEnv, actor: Actor, name: string): Promise<Response> {
  requirePermission(actor, "generator.jobs.read");
  const key = keyOf(name);
  const head = await env.ADMIN_ARTIFACTS.head(key);
  if (head === null) throw new ServiceError(404, "NOT_FOUND");
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Cache-Control": "private, no-store",
    "Accept-Ranges": "bytes",
    "X-Mora-Sha256": head.customMetadata?.sha256 ?? "",
    ETag: head.httpEtag,
  });
  const wanted = request.headers.get("range")?.match(/^bytes=(\d+)-$/u)?.[1];
  const start = wanted === undefined ? 0 : Number(wanted);
  if (start >= head.size && head.size > 0) throw new ServiceError(416, "INVALID_RANGE");
  headers.set("Content-Length", String(head.size - start));
  if (wanted !== undefined) headers.set("Content-Range", `bytes ${start}-${head.size - 1}/${head.size}`);
  if (request.method === "HEAD") return new Response(null, { status: wanted === undefined ? 200 : 206, headers });
  const object = await env.ADMIN_ARTIFACTS.get(key, wanted === undefined ? {} : { range: { offset: start } });
  if (object === null) throw new ServiceError(404, "NOT_FOUND");
  return new Response(object.body, { status: wanted === undefined ? 200 : 206, headers });
}
