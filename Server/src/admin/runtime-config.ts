import { ServiceError } from "../../../packages/core/src/shared/errors.js";
import type { WorkerEnv } from "../env.js";
import { audit, requirePermission, type Actor } from "./auth.js";
import { openSecret, sealSecret } from "./secrets.js";

export type RuntimeValueType = "boolean" | "number" | "origin" | "rp-id" | "secret" | "string" | "url";
export type RuntimeComponent = "server" | "collector";

export interface RuntimeConfigDefinition {
  key: string;
  label: string;
  description: string;
  type: RuntimeValueType;
  secret: boolean;
  component: RuntimeComponent;
  environmentName?: string;
  defaultValue?: string;
  min?: number;
  max?: number;
  normalize?: (value: string) => string;
  validate?: (value: string) => boolean;
}

export const runtimeConfigDefinitions: readonly RuntimeConfigDefinition[] = [
  {
    key: "server.dump_url",
    label: "외부 덤프 URL",
    description: "비워두면 PUBLIC_DUMPS R2의 mora-public.sqlite를 Worker가 직접 제공합니다.",
    type: "url",
    secret: false,
    component: "server",
  },
  {
    key: "server.admin_rp_id",
    label: "WebAuthn RP ID",
    description: "커스텀 도메인을 사용할 때의 호스트 이름입니다. 비워두면 요청 호스트를 사용합니다.",
    type: "rp-id",
    secret: false,
    component: "server",
  },
  {
    key: "server.admin_origin",
    label: "Admin Origin",
    description: "패스키 검증에 사용할 정확한 HTTPS origin입니다. 비워두면 현재 요청 origin을 사용합니다.",
    type: "origin",
    secret: false,
    component: "server",
  },
  {
    key: "server.youtube_api_key",
    label: "YouTube Data API 키",
    description: "곡 상세 화면에서 음원을 직접 검색할 때 사용합니다. 비워두면 검색창 대신 YouTube 링크만 표시합니다.",
    type: "secret",
    secret: true,
    component: "server",
  },
  {
    key: "quality_threshold",
    label: "자동 승격 품질 임계치",
    description: "캘리브레이션 완료 후 자동 공개할 최소 품질 점수입니다.",
    type: "number",
    secret: false,
    component: "server",
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
    component: "server",
    defaultValue: "false",
  },
  {
    key: "server.notification_timeout_ms",
    label: "Webhook 제한 시간",
    description: "Discord 및 범용 Webhook 한 건의 최대 전송 시간입니다.",
    type: "number",
    secret: false,
    component: "server",
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
    component: "server",
  },
  {
    key: "collector.user_agent",
    label: "MusicBrainz User-Agent",
    description: "Collector가 MusicBrainz 요청에 사용하는 서비스명과 연락처입니다.",
    type: "string",
    secret: false,
    component: "collector",
    environmentName: "MORA_USER_AGENT",
    defaultValue: "Mora/0.1 (contact@example.com)",
    max: 500,
  },
  {
    key: "collector.daily_budget",
    label: "일일 수집 한도",
    description: "한 번의 수집 주기에서 처리할 최대 곡 수입니다.",
    type: "number",
    secret: false,
    component: "collector",
    environmentName: "COLLECTOR_DAILY_BUDGET",
    defaultValue: "300",
    min: 1,
    max: 5000,
  },
  {
    key: "collector.interval_ms",
    label: "수집 주기",
    description: "반복 실행 간격(ms)입니다. 최소 60초입니다.",
    type: "number",
    secret: false,
    component: "collector",
    environmentName: "COLLECTOR_INTERVAL_MS",
    defaultValue: "86400000",
    min: 60000,
    max: 604800000,
  },
  {
    key: "collector.once",
    label: "한 번만 실행",
    description: "활성화하면 한 번 수집한 뒤 Collector 프로세스를 종료합니다.",
    type: "boolean",
    secret: false,
    component: "collector",
    environmentName: "COLLECTOR_ONCE",
    defaultValue: "false",
  },
  {
    key: "collector.markets",
    label: "수집 국가",
    description: "쉼표로 구분한 KR, US, JP 목록입니다.",
    type: "string",
    secret: false,
    component: "collector",
    environmentName: "COLLECTOR_MARKETS",
    defaultValue: "KR,US,JP",
    normalize: (value) =>
      value
        .split(",")
        .map((item) => item.trim().toUpperCase())
        .filter(Boolean)
        .join(","),
    validate: (value) => value.length > 0 && value.split(",").every((item) => ["KR", "US", "JP"].includes(item)),
  },
  {
    key: "collector.songtitle_providers",
    label: "가사 Provider",
    description: "쉼표로 구분합니다. 기본값은 등록된 모든 SongTitle provider입니다.",
    type: "string",
    secret: false,
    component: "collector",
    environmentName: "SONGTITLE_PROVIDERS",
    normalize: (value) =>
      value
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
        .join(","),
    validate: (value) =>
      value.length > 0 && value.split(",").every((item) => /^(?:melon|bugs|genie|flo|vibe|genius|shazam|lyricfind)$/u.test(item)),
  },
  {
    key: "collector.songtitle_timeout_ms",
    label: "Provider 제한 시간",
    description: "가사 provider 한 곳의 최대 요청 시간(ms)입니다.",
    type: "number",
    secret: false,
    component: "collector",
    environmentName: "SONGTITLE_TIMEOUT_MS",
    defaultValue: "12000",
    min: 1000,
    max: 60000,
  },
  {
    key: "collector.songtitle_browser",
    label: "브라우저 폴백",
    description: "HTTP 조회 실패 시 설치된 Chromium으로 브라우저 수집을 시도합니다.",
    type: "boolean",
    secret: false,
    component: "collector",
    environmentName: "SONGTITLE_BROWSER",
    defaultValue: "false",
  },
  {
    key: "collector.songtitle_headful",
    label: "브라우저 창 표시",
    description: "브라우저 폴백을 디버깅할 때 Chromium 창을 표시합니다.",
    type: "boolean",
    secret: false,
    component: "collector",
    environmentName: "SONGTITLE_HEADFUL",
    defaultValue: "false",
  },
  {
    key: "collector.spotify_client_id",
    label: "Spotify Client ID",
    description: "MusicBrainz가 못 찾은 곡의 ISRC와 정확한 길이를 채웁니다. 비워두면 Spotify 조회를 건너뜁니다.",
    type: "string",
    secret: false,
    component: "collector",
    environmentName: "SPOTIFY_CLIENT_ID",
  },
  {
    key: "collector.spotify_client_secret",
    label: "Spotify Client Secret",
    description: "Spotify 앱의 Client Secret입니다. Collector에만 복호화되어 전달됩니다.",
    type: "secret",
    secret: true,
    component: "collector",
    environmentName: "SPOTIFY_CLIENT_SECRET",
  },
  {
    key: "collector.genius_access_token",
    label: "Genius Access Token",
    description: "Genius API 접근 토큰입니다. Collector에만 복호화되어 전달됩니다.",
    type: "secret",
    secret: true,
    component: "collector",
    environmentName: "GENIUS_ACCESS_TOKEN",
  },
  {
    key: "collector.lyricfind_api_key",
    label: "LyricFind API Key",
    description: "LyricFind API 키입니다. Collector에만 복호화되어 전달됩니다.",
    type: "secret",
    secret: true,
    component: "collector",
    environmentName: "LYRICFIND_API_KEY",
  },
  {
    key: "collector.lyricfind_territory",
    label: "LyricFind Territory",
    description: "LyricFind 요청에 사용할 2자리 국가 코드입니다.",
    type: "string",
    secret: false,
    component: "collector",
    environmentName: "LYRICFIND_TERRITORY",
    defaultValue: "KR",
    normalize: (value) => value.toUpperCase(),
    validate: (value) => /^[A-Z]{2}$/u.test(value),
  },
  {
    key: "collector.lyrics_library_module",
    label: "외부 LyricsProvider 모듈",
    description: "내장 SongTitle을 완전히 교체할 때 Collector 호스트의 절대 모듈 경로를 입력합니다.",
    type: "string",
    secret: false,
    component: "collector",
    environmentName: "LYRICS_LIBRARY_MODULE",
    validate: (value) => value.startsWith("/"),
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
    return (
      (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) && url.origin === value
    );
  } catch {
    return false;
  }
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
    } catch {
      throw new ServiceError(400, "INVALID_SETTING_VALUE");
    }
  } else if (definition.type === "origin" && !validOrigin(value)) {
    throw new ServiceError(400, "INVALID_SETTING_VALUE");
  } else if (
    definition.type === "rp-id" &&
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(value)
  ) {
    throw new ServiceError(400, "INVALID_SETTING_VALUE");
  }
  const normalized = definition.normalize?.(value) ?? value;
  if (
    (definition.max !== undefined && definition.type === "string" && normalized.length > definition.max) ||
    (definition.validate !== undefined && !definition.validate(normalized))
  ) {
    throw new ServiceError(400, "INVALID_SETTING_VALUE");
  }
  return normalized;
}

export async function runtimeValue(env: WorkerEnv, key: string): Promise<string | undefined> {
  const definition = definitionFor(key);
  const row = await env.ADMIN_DB.prepare("SELECT value,secret FROM settings WHERE key=?1")
    .bind(key)
    .first<{ value: string; secret: number }>();
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
      component: definition.component,
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

export async function collectorRuntimeConfig(env: WorkerEnv, actor: Actor): Promise<Response> {
  requirePermission(actor, "collector.config.read");
  const collectorDefinitions = runtimeConfigDefinitions.filter(
    (definition) => definition.component === "collector" && definition.environmentName !== undefined,
  );
  const entries = await Promise.all(
    collectorDefinitions.map(
      async (definition) => [definition.environmentName as string, await runtimeValue(env, definition.key)] as const,
    ),
  );
  const values = Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry[1] !== undefined));
  return Response.json({ schema_version: 1, values }, { headers: { "Cache-Control": "no-store" } });
}

export async function putRuntimeConfig(env: WorkerEnv, actor: Actor, key: string, body: Record<string, unknown>): Promise<Response> {
  requirePermission(actor, "settings.manage");
  const definition = definitionFor(key);
  const value = normalizeRuntimeValue(definition, body.value);
  const stored = definition.secret ? await sealSecret(env, value) : value;
  const now = Date.now();
  await env.ADMIN_DB.prepare(
    `
    INSERT INTO settings (key,value,secret,updated_by,updated_at) VALUES (?1,?2,?3,?4,?5)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,secret=excluded.secret,updated_by=excluded.updated_by,updated_at=excluded.updated_at
  `,
  )
    .bind(key, stored, definition.secret ? 1 : 0, actor.id, now)
    .run();
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
