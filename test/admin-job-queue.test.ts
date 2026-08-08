import assert from "node:assert/strict";
import { test } from "node:test";
import { AdminClient } from "../Generator/src/admin-client.js";
import { AdminJobQueue } from "../Generator/src/admin-queue.js";

test("Generator consumes jobs through Mora Admin with its service key", async () => {
  const calls: Array<{ path: string; authorization: string | null; body: unknown }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({
      path: url.pathname,
      authorization: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    });
    if (url.pathname.endsWith("/pull"))
      return Response.json({
        id: "job-1",
        body: { schema_version: 1, job_id: "job-1", input_revision_id: "input-1" },
        attempts: 1,
        leaseId: "job-1",
      });
    return Response.json({ accepted: true });
  };
  const queue = new AdminJobQueue(new AdminClient("https://mora.example", "mora_generator_key", fetcher));
  assert.equal((await queue.pull())?.body.job_id, "job-1");
  await queue.retry("job-1", 30);
  await queue.ack("job-1");
  assert.deepEqual(calls, [
    { path: "/admin/api/generator/queue/pull", authorization: "Bearer mora_generator_key", body: {} },
    {
      path: "/admin/api/generator/queue/retry",
      authorization: "Bearer mora_generator_key",
      body: { lease_id: "job-1", delay_seconds: 30 },
    },
    { path: "/admin/api/generator/queue/ack", authorization: "Bearer mora_generator_key", body: { lease_id: "job-1" } },
  ]);
});

test("Generator treats an empty Admin queue as idle", async () => {
  const fetcher: typeof fetch = async () => new Response(null, { status: 204 });
  const queue = new AdminJobQueue(new AdminClient("https://mora.example", "mora_generator_key", fetcher));
  assert.equal(await queue.pull(), null);
});
