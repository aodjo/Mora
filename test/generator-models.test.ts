import assert from "node:assert/strict";
import { test } from "node:test";
import { ServiceError } from "../packages/core/src/shared/errors.js";
import type { WorkerEnv } from "../Server/src/env.js";
import type { Actor } from "../Server/src/admin/auth.js";
import { completeModelUpload, serveModel, startModelUpload, uploadModelPart } from "../Server/src/admin/models.js";

/**
 * A bucket that keeps objects in memory and joins multipart uploads the way R2 does.
 *
 * @returns {{ bucket: R2Bucket, objects: Map<string, { data: Uint8Array, meta: Record<string, string> }> }} The fake and its store.
 */
function memoryBucket() {
  const objects = new Map<string, { data: Uint8Array; meta: Record<string, string> }>();
  const uploads = new Map<string, { key: string; meta: Record<string, string>; parts: Map<number, Uint8Array> }>();
  const bytes = async (value: unknown) => new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
  const bucket = {
    async createMultipartUpload(key: string, options?: { customMetadata?: Record<string, string> }) {
      const uploadId = `up-${uploads.size + 1}`;
      uploads.set(uploadId, { key, meta: options?.customMetadata ?? {}, parts: new Map() });
      return { uploadId, key };
    },
    resumeMultipartUpload(key: string, uploadId: string) {
      const upload = uploads.get(uploadId);
      if (upload === undefined || upload.key !== key) throw new Error("no such upload");
      return {
        async uploadPart(partNumber: number, value: unknown) {
          upload.parts.set(partNumber, await bytes(value));
          return { partNumber, etag: `etag-${partNumber}` };
        },
        async complete(parts: Array<{ partNumber: number; etag: string }>) {
          const joined = parts
            .sort((a, b) => a.partNumber - b.partNumber)
            .flatMap((one) => Array.from(upload.parts.get(one.partNumber) ?? new Uint8Array()));
          objects.set(key, { data: Uint8Array.from(joined), meta: upload.meta });
          return { size: joined.length };
        },
      };
    },
    async head(key: string) {
      const object = objects.get(key);
      return object === undefined ? null : { size: object.data.length, customMetadata: object.meta, httpEtag: '"e"' };
    },
    async get(key: string, options?: { range?: { offset: number } }) {
      const object = objects.get(key);
      if (object === undefined) return null;
      return { body: new Response(object.data.slice(options?.range?.offset ?? 0)).body };
    },
  };
  return { bucket: bucket as unknown as R2Bucket, objects };
}

/**
 * A database that swallows the audit rows.
 *
 * @returns {D1Database} The fake.
 */
function quietDatabase(): D1Database {
  return { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) } as unknown as D1Database;
}

const admin: Actor = { type: "user", id: "admin", permissions: new Set(["*"]) };
const worker: Actor = { type: "service", id: "worker", permissions: new Set(["generator.jobs.read"]) };

test("A model goes up in parts, comes back whole, and resumes from a byte offset", async () => {
  const { bucket } = memoryBucket();
  const env = { ADMIN_ARTIFACTS: bucket, ADMIN_DB: quietDatabase() } as unknown as WorkerEnv;
  const digest = "a".repeat(64);
  const started = (await (await startModelUpload(env, admin, "mms_sing_b.pt", { byte_size: 6, sha256: digest })).json()) as {
    upload_id: string;
  };
  const parts = [];
  for (const [index, text] of ["abc", "def"].entries()) {
    const response = await uploadModelPart(
      new Request("https://mora.example", { method: "PUT", body: text }),
      env,
      admin,
      "mms_sing_b.pt",
      started.upload_id,
      index + 1,
    );
    parts.push(await response.json());
  }
  await completeModelUpload(env, admin, "mms_sing_b.pt", started.upload_id, { parts });

  const whole = await serveModel(new Request("https://mora.example"), env, worker, "mms_sing_b.pt");
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("x-mora-sha256"), digest);
  assert.equal(await whole.text(), "abcdef");

  const rest = await serveModel(new Request("https://mora.example", { headers: { range: "bytes=2-" } }), env, worker, "mms_sing_b.pt");
  assert.equal(rest.status, 206);
  assert.equal(rest.headers.get("content-range"), "bytes 2-5/6");
  assert.equal(await rest.text(), "cdef");
});

test("Only an admin uploads, only a job reader downloads, and names stay plain", async () => {
  const { bucket } = memoryBucket();
  const env = { ADMIN_ARTIFACTS: bucket, ADMIN_DB: quietDatabase() } as unknown as WorkerEnv;
  const forbidden = (error: unknown) => error instanceof ServiceError && error.code === "FORBIDDEN";
  await assert.rejects(startModelUpload(env, worker, "b.pt", { byte_size: 1, sha256: "a".repeat(64) }), forbidden);
  const stranger: Actor = { type: "service", id: "other", permissions: new Set(["workers.heartbeat"]) };
  await assert.rejects(serveModel(new Request("https://mora.example"), env, stranger, "b.pt"), forbidden);
  await assert.rejects(
    serveModel(new Request("https://mora.example"), env, worker, "../jobs/secret"),
    (error: unknown) => error instanceof ServiceError && error.code === "INVALID_REQUEST",
  );
});
