import { ServiceError } from "../../../packages/core/src/shared/errors.js";
import type { WorkerEnv } from "../env.js";
import { audit, requirePermission, sha256, type Actor } from "./auth.js";
import { openSecret, sealSecret } from "./secrets.js";

const pairingLifetimeMs = 10 * 60_000;
const collectorScopes = ["collector.config.read", "collector.submit"] as const;
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

export function normalizeCollectorPairingPin(value: unknown): string {
  if (typeof value !== "string") throw new ServiceError(400, "INVALID_REQUEST");
  const pin = value.replace(/[\s-]/gu, "");
  if (!/^\d{10}$/u.test(pin)) throw new ServiceError(400, "INVALID_REQUEST");
  return pin;
}

export async function startCollectorPairing(env: WorkerEnv, value: Record<string, unknown>): Promise<Response> {
  const name = typeof value.name === "string" && value.name.trim().length > 0 && value.name.length <= 100
    ? value.name.trim()
    : "Collector";
  const now = Date.now();
  await env.ADMIN_DB.prepare("DELETE FROM collector_pairings WHERE expires_at<=?1").bind(now).run();
  const active = await env.ADMIN_DB.prepare("SELECT COUNT(*) count FROM collector_pairings WHERE status='pending' AND expires_at>?1").bind(now).first<{ count: number }>();
  if ((active?.count ?? 0) >= 50) throw new ServiceError(409, "CONFLICT");

  let pin = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = randomPin();
    const collision = await env.ADMIN_DB.prepare("SELECT id FROM collector_pairings WHERE pin_hash=?1").bind(await sha256(candidate)).first<{ id: string }>();
    if (collision === null) { pin = candidate; break; }
  }
  if (pin.length === 0) throw new ServiceError(500, "INTERNAL");

  const id = crypto.randomUUID();
  const deviceCode = randomSecret();
  const expiresAt = now + pairingLifetimeMs;
  await env.ADMIN_DB.prepare("INSERT INTO collector_pairings (id,pin_hash,device_hash,name,expires_at,created_at) VALUES (?1,?2,?3,?4,?5,?6)")
    .bind(id, await sha256(pin), await sha256(deviceCode), name, expiresAt, now).run();
  await audit(env, null, "collector.pairing.start", "collector_pairing", id, { name });
  return json({ pairing_id: id, device_code: deviceCode, pin, expires_at: expiresAt, interval_ms: 2000 }, 201);
}

export async function pollCollectorPairing(request: Request, env: WorkerEnv, pairingId: string): Promise<Response> {
  const deviceCode = request.headers.get("authorization")?.match(/^Pairing\s+(.+)$/iu)?.[1];
  if (deviceCode === undefined) throw new ServiceError(401, "UNAUTHORIZED");
  const row = await env.ADMIN_DB.prepare("SELECT status,credential_ciphertext,expires_at FROM collector_pairings WHERE id=?1 AND device_hash=?2")
    .bind(pairingId, await sha256(deviceCode)).first<{ status: string; credential_ciphertext: string | null; expires_at: number }>();
  if (row === null || row.expires_at <= Date.now()) throw new ServiceError(401, "UNAUTHORIZED");
  if (row.status === "pending") return json({ status: "pending", expires_at: row.expires_at }, 202);
  if (row.credential_ciphertext === null) throw new ServiceError(500, "INTERNAL");
  await env.ADMIN_DB.prepare("UPDATE collector_pairings SET consumed_at=COALESCE(consumed_at,?1) WHERE id=?2").bind(Date.now(), pairingId).run();
  return json({ status: "approved", api_key: await openSecret(env, row.credential_ciphertext) });
}

export async function approveCollectorPairing(env: WorkerEnv, actor: Actor, value: Record<string, unknown>): Promise<Response> {
  requirePermission(actor, "service_keys.manage");
  const pin = normalizeCollectorPairingPin(value.pin);
  const row = await env.ADMIN_DB.prepare("SELECT id,name FROM collector_pairings WHERE pin_hash=?1 AND status='pending' AND expires_at>?2")
    .bind(await sha256(pin), Date.now()).first<{ id: string; name: string }>();
  if (row === null) throw new ServiceError(404, "NOT_FOUND");

  const secret = randomSecret();
  const keyId = crypto.randomUUID();
  const now = Date.now();
  await env.ADMIN_DB.batch([
    env.ADMIN_DB.prepare("INSERT INTO service_keys (id,name,prefix,secret_hash,scopes,created_at) VALUES (?1,?2,?3,?4,?5,?6)")
      .bind(keyId, `collector:${row.name}`, secret.slice(0, 13), await sha256(secret), JSON.stringify(collectorScopes), now),
    env.ADMIN_DB.prepare("UPDATE collector_pairings SET status='approved',credential_ciphertext=?1,approved_by=?2,approved_at=?3 WHERE id=?4 AND status='pending'")
      .bind(await sealSecret(env, secret), actor.type === "user" ? actor.id : null, now, row.id),
  ]);
  await audit(env, actor, "collector.pairing.approve", "collector_pairing", row.id, { name: row.name, service_key_id: keyId });
  return json({ pairing_id: row.id, status: "approved" });
}
