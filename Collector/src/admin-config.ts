export interface CollectorRuntimeConfig {
  userAgent: string;
  dailyBudget: number;
  intervalMs: number;
  once: boolean;
  markets: Array<"KR" | "US" | "JP">;
  providers?: string[];
  songTitleTimeoutMs: number;
  songTitleBrowser: boolean;
  songTitleHeadful: boolean;
  geniusAccessToken?: string;
  lyricFindApiKey?: string;
  lyricFindTerritory: string;
  lyricsLibraryModule?: string;
}

interface ConfigResponse {
  schema_version?: unknown;
  values?: unknown;
}

function required(values: Record<string, unknown>, key: string): string {
  const value = values[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`collector config is missing ${key}`);
  return value;
}

function optional(values: Record<string, unknown>, key: string): string | undefined {
  const value = values[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`collector config has invalid ${key}`);
  return value;
}

function numberValue(values: Record<string, unknown>, key: string, minimum: number, maximum: number): number {
  const value = Number(required(values, key));
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`collector config has invalid ${key}`);
  return value;
}

function booleanValue(values: Record<string, unknown>, key: string): boolean {
  const value = required(values, key);
  if (value !== "true" && value !== "false") throw new Error(`collector config has invalid ${key}`);
  return value === "true";
}

export function parseCollectorRuntimeConfig(payload: ConfigResponse): CollectorRuntimeConfig {
  if (payload.schema_version !== 1 || typeof payload.values !== "object" || payload.values === null || Array.isArray(payload.values)) {
    throw new Error("collector config response is invalid");
  }
  const values = payload.values as Record<string, unknown>;
  const markets = required(values, "COLLECTOR_MARKETS").split(",");
  if (markets.length === 0 || markets.some((market) => !["KR", "US", "JP"].includes(market)))
    throw new Error("collector config has invalid COLLECTOR_MARKETS");
  const providerValue = optional(values, "SONGTITLE_PROVIDERS");
  const modulePath = optional(values, "LYRICS_LIBRARY_MODULE");
  const geniusAccessToken = optional(values, "GENIUS_ACCESS_TOKEN");
  const lyricFindApiKey = optional(values, "LYRICFIND_API_KEY");
  return {
    userAgent: required(values, "MORA_USER_AGENT"),
    // 0은 유효한 목표다: "이번 회차는 여기까지"라고 콘솔이 말한 상태이지 잘못된 설정이 아니다.
    dailyBudget: numberValue(values, "COLLECTOR_DAILY_BUDGET", 0, 5000),
    intervalMs: numberValue(values, "COLLECTOR_INTERVAL_MS", 60_000, 604_800_000),
    once: booleanValue(values, "COLLECTOR_ONCE"),
    markets: markets as Array<"KR" | "US" | "JP">,
    ...(providerValue === undefined ? {} : { providers: providerValue.split(",") }),
    songTitleTimeoutMs: numberValue(values, "SONGTITLE_TIMEOUT_MS", 1000, 60_000),
    songTitleBrowser: booleanValue(values, "SONGTITLE_BROWSER"),
    songTitleHeadful: booleanValue(values, "SONGTITLE_HEADFUL"),
    ...(geniusAccessToken === undefined ? {} : { geniusAccessToken }),
    ...(lyricFindApiKey === undefined ? {} : { lyricFindApiKey }),
    lyricFindTerritory: required(values, "LYRICFIND_TERRITORY"),
    ...(modulePath === undefined ? {} : { lyricsLibraryModule: modulePath }),
  };
}

export async function fetchCollectorRuntimeConfig(
  adminUrl: string,
  adminToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CollectorRuntimeConfig> {
  const response = await fetchImpl(`${adminUrl.replace(/\/$/u, "")}/admin/api/collector/config`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  if (!response.ok) throw new Error(`COLLECTOR_CONFIG_${response.status}`);
  return parseCollectorRuntimeConfig((await response.json()) as ConfigResponse);
}
