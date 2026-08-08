import type { WorkerCapabilities } from "../../../packages/contracts/src/index.js";
import { ServiceError } from "../../../packages/core/src/shared/errors.js";
import type { WorkerEnv } from "../env.js";
import { audit, requirePermission, sha256, type Actor } from "./auth.js";
import { openSecret, sealSecret } from "./secrets.js";

const pairingLifetimeMs = 10 * 60_000;
const generatorScopes = [
  "generator.jobs.read",
  "generator.events.write",
  "generator.candidates.write",
  "generator.artifacts.write",
  "workers.heartbeat",
] as const;
const responseHeaders = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" } as const;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: responseHeaders });
}

function randomSecret(): string {
  const data = crypto.getRandomValues(new Uint8Array(32));
  return `mora_${Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function randomPin(): string {
  let result = "";
  while (result.length < 10) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    for (const byte of bytes) {
      if (byte < 250) result += String(byte % 10);
      if (result.length === 10) break;
    }
  }
  return result;
}

export function normalizeGeneratorPairingPin(value: unknown): string {
  if (typeof value !== "string") throw new ServiceError(400, "INVALID_REQUEST");
  const pin = value.replace(/[\s-]/gu, "");
  if (!/^\d{10}$/u.test(pin)) throw new ServiceError(400, "INVALID_REQUEST");
  return pin;
}

function capabilities(value: unknown): WorkerCapabilities {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ServiceError(400, "INVALID_REQUEST");
  const item = value as Record<string, unknown>;
  if (typeof item.worker_id !== "string" || item.worker_id.length === 0 || item.worker_id.length > 100)
    throw new ServiceError(400, "INVALID_REQUEST");
  if (typeof item.version !== "string" || item.version.length === 0 || item.version.length > 100)
    throw new ServiceError(400, "INVALID_REQUEST");
  if (!(["mps", "cuda", "xpu", "rocm"] as unknown[]).includes(item.backend)) throw new ServiceError(400, "INVALID_REQUEST");
  if (typeof item.hardware !== "string" || item.hardware.length === 0 || item.hardware.length > 500)
    throw new ServiceError(400, "INVALID_REQUEST");
  if (
    !Array.isArray(item.capabilities) ||
    item.capabilities.length > 100 ||
    item.capabilities.some((entry) => typeof entry !== "string" || entry.length > 100)
  )
    throw new ServiceError(400, "INVALID_REQUEST");
  if (
    typeof item.production_ready !== "boolean" ||
    typeof item.self_test !== "object" ||
    item.self_test === null ||
    Array.isArray(item.self_test)
  )
    throw new ServiceError(400, "INVALID_REQUEST");
  const selfTest = item.self_test as Record<string, unknown>;
  if (
    Object.keys(selfTest).length > 100 ||
    Object.entries(selfTest).some(([key, state]) => key.length > 100 || !["passed", "failed", "skipped"].includes(String(state)))
  )
    throw new ServiceError(400, "INVALID_REQUEST");
  return item as unknown as WorkerCapabilities;
}

export async function startGeneratorPairing(env: WorkerEnv, value: Record<string, unknown>): Promise<Response> {
  const name = typeof value.name === "string" && value.name.trim().length > 0 && value.name.length <= 100 ? value.name.trim() : "Generator";
  const worker = capabilities(value.capabilities);
  if (!worker.production_ready) throw new ServiceError(400, "INVALID_REQUEST");
  const now = Date.now();
  await env.ADMIN_DB.prepare("DELETE FROM generator_pairings WHERE expires_at<=?1").bind(now).run();
  const active = await env.ADMIN_DB.prepare("SELECT COUNT(*) count FROM generator_pairings WHERE status='pending' AND expires_at>?1")
    .bind(now)
    .first<{ count: number }>();
  if ((active?.count ?? 0) >= 50) throw new ServiceError(409, "CONFLICT");
  if ((await env.ADMIN_DB.prepare("SELECT id FROM workers WHERE id=?1").bind(worker.worker_id).first<{ id: string }>()) !== null)
    throw new ServiceError(409, "CONFLICT");

  let pin = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = randomPin();
    const collision = await env.ADMIN_DB.prepare("SELECT id FROM generator_pairings WHERE pin_hash=?1")
      .bind(await sha256(candidate))
      .first<{ id: string }>();
    if (collision === null) {
      pin = candidate;
      break;
    }
  }
  if (pin.length === 0) throw new ServiceError(500, "INTERNAL");

  const id = crypto.randomUUID();
  const deviceCode = randomSecret();
  const expiresAt = now + pairingLifetimeMs;
  await env.ADMIN_DB.prepare(
    "INSERT INTO generator_pairings (id,pin_hash,device_hash,name,capabilities,worker_id,expires_at,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
  )
    .bind(id, await sha256(pin), await sha256(deviceCode), name, JSON.stringify(worker), worker.worker_id, expiresAt, now)
    .run();
  await audit(env, null, "generator.pairing.start", "generator_pairing", id, {
    name,
    worker_id: worker.worker_id,
    backend: worker.backend,
  });
  return json({ pairing_id: id, device_code: deviceCode, pin, expires_at: expiresAt, interval_ms: 2000 }, 201);
}

export async function pollGeneratorPairing(request: Request, env: WorkerEnv, pairingId: string): Promise<Response> {
  const deviceCode = request.headers.get("authorization")?.match(/^Pairing\s+(.+)$/iu)?.[1];
  if (deviceCode === undefined) throw new ServiceError(401, "UNAUTHORIZED");
  const row = await env.ADMIN_DB.prepare(
    "SELECT status,credential_ciphertext,worker_id,expires_at FROM generator_pairings WHERE id=?1 AND device_hash=?2",
  )
    .bind(pairingId, await sha256(deviceCode))
    .first<{ status: string; credential_ciphertext: string | null; worker_id: string; expires_at: number }>();
  if (row === null || row.expires_at <= Date.now()) throw new ServiceError(401, "UNAUTHORIZED");
  if (row.status === "pending") return json({ status: "pending", expires_at: row.expires_at }, 202);
  if (row.credential_ciphertext === null) throw new ServiceError(500, "INTERNAL");
  await env.ADMIN_DB.prepare("UPDATE generator_pairings SET consumed_at=COALESCE(consumed_at,?1) WHERE id=?2")
    .bind(Date.now(), pairingId)
    .run();
  return json({ status: "approved", worker_id: row.worker_id, api_key: await openSecret(env, row.credential_ciphertext) });
}

export async function approveGeneratorPairing(env: WorkerEnv, actor: Actor, value: Record<string, unknown>): Promise<Response> {
  requirePermission(actor, "workers.manage");
  const pin = normalizeGeneratorPairingPin(value.pin);
  const row = await env.ADMIN_DB.prepare(
    "SELECT id,name,worker_id,capabilities FROM generator_pairings WHERE pin_hash=?1 AND status='pending' AND expires_at>?2",
  )
    .bind(await sha256(pin), Date.now())
    .first<{ id: string; name: string; worker_id: string; capabilities: string }>();
  if (row === null) throw new ServiceError(404, "NOT_FOUND");
  const worker = capabilities(JSON.parse(row.capabilities) as unknown);
  const secret = randomSecret();
  const keyId = crypto.randomUUID();
  const now = Date.now();
  await env.ADMIN_DB.batch([
    env.ADMIN_DB.prepare(
      "INSERT INTO workers (id,name,version,backend,hardware,capabilities,self_test,production_ready,last_seen_at,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)",
    ).bind(
      worker.worker_id,
      row.name,
      worker.version,
      worker.backend,
      worker.hardware,
      JSON.stringify(worker.capabilities),
      JSON.stringify(worker.self_test),
      worker.production_ready ? 1 : 0,
      now,
    ),
    env.ADMIN_DB.prepare("INSERT INTO service_keys (id,name,prefix,secret_hash,scopes,created_at) VALUES (?1,?2,?3,?4,?5,?6)").bind(
      keyId,
      `worker:${row.worker_id}`,
      secret.slice(0, 13),
      await sha256(secret),
      JSON.stringify(generatorScopes),
      now,
    ),
    env.ADMIN_DB.prepare(
      "UPDATE generator_pairings SET status='approved',credential_ciphertext=?1,approved_by=?2,approved_at=?3 WHERE id=?4 AND status='pending'",
    ).bind(await sealSecret(env, secret), actor.type === "user" ? actor.id : null, now, row.id),
  ]);
  await audit(env, actor, "generator.pairing.approve", "generator_pairing", row.id, {
    name: row.name,
    worker_id: row.worker_id,
    service_key_id: keyId,
  });
  return json({ pairing_id: row.id, worker_id: row.worker_id, status: "approved" });
}
