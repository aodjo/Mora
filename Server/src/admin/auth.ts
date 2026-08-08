import type { WorkerEnv } from "../env.js";
import { ServiceError } from "../../../packages/core/src/shared/errors.js";

export interface Actor {
  type: "user" | "service";
  id: string;
  permissions: Set<string>;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cookie(request: Request, name: string): string | undefined {
  const source = request.headers.get("cookie") ?? "";
  for (const part of source.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function permissionSet(rows: Array<{ permissions: string }>): Set<string> {
  const permissions = new Set<string>();
  for (const row of rows) {
    const parsed = JSON.parse(row.permissions) as unknown;
    if (Array.isArray(parsed)) for (const item of parsed) if (typeof item === "string") permissions.add(item);
  }
  return permissions;
}

export async function authenticate(request: Request, env: WorkerEnv): Promise<Actor> {
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/iu)?.[1];
  if (bearer !== undefined) {
    const hash = await sha256(bearer);
    const row = await env.ADMIN_DB.prepare(
      `
      SELECT id, scopes FROM service_keys
      WHERE secret_hash = ?1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?2)
    `,
    )
      .bind(hash, Date.now())
      .first<{ id: string; scopes: string }>();
    if (row !== null) {
      await env.ADMIN_DB.prepare("UPDATE service_keys SET last_used_at = ?1 WHERE id = ?2").bind(Date.now(), row.id).run();
      return { type: "service", id: row.id, permissions: permissionSet([{ permissions: row.scopes }]) };
    }
  }

  const session = cookie(request, "mora_session");
  if (session !== undefined) {
    const hash = await sha256(session);
    const user = await env.ADMIN_DB.prepare(
      `
      SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ?1 AND s.expires_at > ?2 AND u.status = 'active'
    `,
    )
      .bind(hash, Date.now())
      .first<{ id: string }>();
    if (user !== null) {
      const roles = await env.ADMIN_DB.prepare(
        `
        SELECT r.permissions FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?1
      `,
      )
        .bind(user.id)
        .all<{ permissions: string }>();
      await env.ADMIN_DB.prepare("UPDATE sessions SET last_seen_at = ?1 WHERE id_hash = ?2").bind(Date.now(), hash).run();
      return { type: "user", id: user.id, permissions: permissionSet(roles.results) };
    }
  }
  throw new ServiceError(401, "UNAUTHORIZED");
}

export function requirePermission(actor: Actor, permission: string): void {
  if (!actor.permissions.has("*") && !actor.permissions.has(permission)) {
    throw new ServiceError(403, "FORBIDDEN");
  }
}

export async function createSession(database: D1Database, userId: string): Promise<{ token: string; cookie: string }> {
  const token = `${crypto.randomUUID()}${crypto.randomUUID().replaceAll("-", "")}`;
  const now = Date.now();
  await database
    .prepare("INSERT INTO sessions (id_hash, user_id, expires_at, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?4)")
    .bind(await sha256(token), userId, now + 12 * 60 * 60 * 1000, now)
    .run();
  return { token, cookie: `mora_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200` };
}

export async function audit(
  env: WorkerEnv,
  actor: Actor | null,
  action: string,
  targetType: string,
  targetId: string | null,
  summary: Record<string, unknown> = {},
): Promise<void> {
  await env.ADMIN_DB.prepare(
    `
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, summary, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
  `,
  )
    .bind(actor?.type ?? "system", actor?.id ?? null, action, targetType, targetId, JSON.stringify(summary), Date.now())
    .run();
}
