import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdminClient } from "../Generator/src/admin-client.js";

/**
 * A server that holds one model and answers HEAD and ranged GET the way the admin API does.
 *
 * @param {string} content - The model's bytes.
 * @param {string} [digest] - The SHA-256 the server claims; the true one when omitted.
 * @returns {{ fetcher: typeof fetch, calls: string[] }} The fake and the requests it saw.
 */
function modelServer(content: string, digest?: string) {
  const calls: string[] = [];
  const claimed = digest ?? createHash("sha256").update(content).digest("hex");
  const fetcher: typeof fetch = async (_input, init) => {
    const method = init?.method ?? "GET";
    const range = new Headers(init?.headers).get("range");
    calls.push(range === null ? method : `${method} ${range}`);
    const start = range === null ? 0 : Number(/bytes=(\d+)-/u.exec(range)?.[1] ?? 0);
    const headers = { "content-length": String(content.length - start), "x-mora-sha256": claimed };
    if (method === "HEAD") return new Response(null, { status: 200, headers: { ...headers, "content-length": String(content.length) } });
    return new Response(content.slice(start), { status: range === null ? 200 : 206, headers });
  };
  return { fetcher, calls };
}

test("A model is fetched, checked, and not fetched again", async () => {
  const folder = await mkdtemp(join(tmpdir(), "mora-model-"));
  const { fetcher, calls } = modelServer("weights-bytes");
  const admin = new AdminClient("https://mora.example/", "key", fetcher);
  const path = await admin.fetchModel("mms_sing_b.pt", join(folder, "mms_sing_b.pt"));
  assert.equal(await readFile(path, "utf8"), "weights-bytes");
  await admin.fetchModel("mms_sing_b.pt", join(folder, "mms_sing_b.pt"));
  assert.deepEqual(calls, ["HEAD", "GET", "HEAD"]);
});

test("A broken-off download resumes from where it stopped", async () => {
  const folder = await mkdtemp(join(tmpdir(), "mora-model-"));
  await writeFile(join(folder, "b.pt.part"), "weights-");
  const { fetcher, calls } = modelServer("weights-bytes");
  const admin = new AdminClient("https://mora.example", "key", fetcher);
  const path = await admin.fetchModel("b.pt", join(folder, "b.pt"));
  assert.equal(await readFile(path, "utf8"), "weights-bytes");
  assert.deepEqual(calls, ["HEAD", "GET bytes=8-"]);
});

test("Bytes that do not match the server's hash never take the model's name", async () => {
  const folder = await mkdtemp(join(tmpdir(), "mora-model-"));
  const { fetcher } = modelServer("weights-bytes", "0".repeat(64));
  const admin = new AdminClient("https://mora.example", "key", fetcher);
  await assert.rejects(admin.fetchModel("b.pt", join(folder, "b.pt")), /MODEL_SHA_MISMATCH/u);
  await assert.rejects(readFile(join(folder, "b.pt")));
});
