import { ServiceError } from "../../../packages/core/src/shared/errors.js";
import type { WorkerEnv } from "../env.js";
import { audit, requirePermission, type Actor } from "./auth.js";
import { openSecret, sealSecret } from "./secrets.js";

export type RuntimeValueType = "boolean" | "number" | "origin" | "rp-id" | "secret" | "url";

export interface RuntimeConfigDefinition {
  key: string;
  label: string;
  description: string;
  type: RuntimeValueType;
  secret: boolean;
  defaultValue?: string;
  min?: number;
  max?: number;
}

export const runtimeConfigDefinitions: readonly RuntimeConfigDefinition[] = [
  {
    key: "server.dump_url",
    label: "외부 덤프 URL",
    description: "비워두면 PUBLIC_DUMPS R2의 mora-public.sqlite를 Worker가 직접 제공합니다.",
    type: "url",
    secret: false,
  },
  {
    key: "server.admin_rp_id",
    label: "WebAuthn RP ID",
    description: "커스텀 도메인을 사용할 때의 호스트 이름입니다. 비워두면 요청 호스트를 사용합니다.",
    type: "rp-id",
    secret: false,
  },
  {
    key: "server.admin_origin",
    label: "Admin Origin",
    description: "패스키 검증에 사용할 정확한 HTTPS origin입니다. 비워두면 현재 요청 origin을 사용합니다.",
    type: "origin",
    secret: false,
  },
  {
    key: "quality_threshold",
    label: "자동 승격 품질 임계치",
    description: "캘리브레이션 완료 후 자동 공개할 최소 품질 점수입니다.",
    type: "number",
    secret: false,
    defaultValue: "0.92",
    min: 0.5,
    max: 1,
  },
  {
    key: "auto_promotion_enabled",
    label: "자동 승격",
    description: "품질 게이트를 통과한 후보의 자동 공개 여부입니다.",
    type: "boolean",
    secret: false,
    defaultValue: "false",
  },
  {
    key: "server.notification_timeout_ms",
    label: "Webhook 제한 시간",
    description: "Discord 및 범용 Webhook 한 건의 최대 전송 시간입니다.",
    type: "number",
    secret: false,
    defaultValue: "5000",
    min: 1000,
    max: 30000,
  },
  {
    key: "server.webhook_signing_secret",
    label: "Webhook 서명키",
    description: "범용 Webhook의 X-Mora-Signature HMAC-SHA256 서명에 사용됩니다.",
    type: "secret",
    secret: true,
  },
] as const;

const definitions = new Map(runtimeConfigDefinitions.map((definition) => [definition.key, definition]));

function definitionFor(key: string): RuntimeConfigDefinition {
  const definition = definitions.get(key);
  if (definition === undefined) throw new ServiceError(404, "SETTING_NOT_FOUND");
  return definition;
}

function validOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
      && url.origin === value;
  } catch { return false; }
}

export function normalizeRuntimeValue(definition: RuntimeConfigDefinition, raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 100_000) throw new ServiceError(400, "INVALID_SETTING_VALUE");
  const value = definition.type === "secret" ? raw : raw.trim();
  if (value.length === 0) throw new ServiceError(400, "INVALID_SETTING_VALUE");
  if (definition.type === "boolean") {
    if (value !== "true" && value !== "false") throw new ServiceError(400, "INVALID_SETTING_VALUE");
  } else if (definition.type === "number") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < (definition.min ?? -Infinity) || parsed > (definition.max ?? Infinity)) {
      throw new ServiceError(400, "INVALID_SETTING_VALUE");
    }
    return String(parsed);
  } else if (definition.type === "url") {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) throw new Error();
    }
    catch { throw new ServiceError(400, "INVALID_SETTING_VALUE"); }
  } else if (definition.type === "origin" && !validOrigin(value)) {
    throw new ServiceError(400, "INVALID_SETTING_VALUE");
  } else if (definition.type === "rp-id" && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(value)) {
    throw new ServiceError(400, "INVALID_SETTING_VALUE");
  }
  return value;
}

export async function runtimeValue(env: WorkerEnv, key: string): Promise<string | undefined> {
  const definition = definitionFor(key);
  const row = await env.ADMIN_DB.prepare("SELECT value,secret FROM settings WHERE key=?1").bind(key).first<{ value: string; secret: number }>();
  if (row === null) return definition.defaultValue;
  return row.secret === 1 ? openSecret(env, row.value) : row.value;
}

export async function listRuntimeConfig(env: WorkerEnv, actor: Actor): Promise<Response> {
  requirePermission(actor, "settings.read");
  const rows = await env.ADMIN_DB.prepare("SELECT key,value,secret,updated_by,updated_at FROM settings").all<{
    key: string;
    value: string;
    secret: number;
    updated_by: string | null;
    updated_at: number;
  }>();
  const byKey = new Map(rows.results.map((row) => [row.key, row]));
  const items = runtimeConfigDefinitions.map((definition) => {
    const row = byKey.get(definition.key);
    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      type: definition.type,
      secret: definition.secret,
      configured: row !== undefined,
      source: row === undefined ? "default" : "database",
      ...(definition.secret ? {} : { value: row?.value ?? definition.defaultValue ?? "" }),
      ...(definition.defaultValue === undefined ? {} : { default_value: definition.defaultValue }),
      ...(row === undefined ? {} : { updated_by: row.updated_by, updated_at: row.updated_at }),
    };
  });
  const bindings = [
    { key: "PUBLIC_DB", kind: "D1 binding", configured: env.PUBLIC_DB !== undefined },
    { key: "ADMIN_DB", kind: "D1 binding", configured: env.ADMIN_DB !== undefined },
    { key: "ADMIN_ARTIFACTS", kind: "R2 binding", configured: env.ADMIN_ARTIFACTS !== undefined },
    { key: "PUBLIC_DUMPS", kind: "R2 binding", configured: env.PUBLIC_DUMPS !== undefined },
    { key: "GENERATION_QUEUE", kind: "Queue binding", configured: env.GENERATION_QUEUE !== undefined },
    { key: "BOOTSTRAP_TOKEN", kind: "Cloudflare secret", configured: env.BOOTSTRAP_TOKEN !== undefined },
    { key: "SECRET_ENCRYPTION_KEY", kind: "Cloudflare secret", configured: env.SECRET_ENCRYPTION_KEY !== undefined },
    { key: "ARTIFACT_PRIVATE_KEY", kind: "Cloudflare secret", configured: env.ARTIFACT_PRIVATE_KEY !== undefined },
  ];
  return Response.json({ items, bindings }, { headers: { "Cache-Control": "no-store" } });
}

export async function putRuntimeConfig(env: WorkerEnv, actor: Actor, key: string, body: Record<string, unknown>): Promise<Response> {
  requirePermission(actor, "settings.manage");
  const definition = definitionFor(key);
  const value = normalizeRuntimeValue(definition, body.value);
  const stored = definition.secret ? await sealSecret(env, value) : value;
  const now = Date.now();
  await env.ADMIN_DB.prepare(`
    INSERT INTO settings (key,value,secret,updated_by,updated_at) VALUES (?1,?2,?3,?4,?5)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,secret=excluded.secret,updated_by=excluded.updated_by,updated_at=excluded.updated_at
  `).bind(key, stored, definition.secret ? 1 : 0, actor.id, now).run();
  await audit(env, actor, "setting.update", "setting", key, { secret: definition.secret });
  return Response.json({ key, configured: true, secret: definition.secret, updated_at: now }, { headers: { "Cache-Control": "no-store" } });
}

export async function deleteRuntimeConfig(env: WorkerEnv, actor: Actor, key: string): Promise<Response> {
  requirePermission(actor, "settings.manage");
  const definition = definitionFor(key);
  await env.ADMIN_DB.prepare("DELETE FROM settings WHERE key=?1").bind(key).run();
  await audit(env, actor, "setting.reset", "setting", key, { secret: definition.secret });
  return new Response(null, { status: 204 });
}

export async function webhookSignature(env: WorkerEnv, payload: string): Promise<string | undefined> {
  const secret = await runtimeValue(env, "server.webhook_signing_secret");
  if (secret === undefined) return undefined;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `sha256=${Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
