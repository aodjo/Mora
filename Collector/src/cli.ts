import type { LyricsProvider } from "../../packages/contracts/src/index.js";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { loadEnvFile } from "node:process";
import { dirname, resolve } from "node:path";
import { fetchCollectorRuntimeConfig, type CollectorRuntimeConfig } from "./admin-config.js";
import { startCollectorPairing, waitForCollectorPairing } from "./pairing.js";
import { CollectorService } from "./service.js";
import { createSongTitleProvider } from "./songtitle-provider.js";
import { startSearchWorker } from "./search-worker.js";
import { LyricFindCatalogue } from "./lyricfind.js";
import { SpotifyClient } from "./spotify.js";

try {
  loadEnvFile(process.env.MORA_COLLECTOR_ENV_FILE ?? resolve(process.cwd(), "Collector/.env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

interface CollectorCredentials {
  admin_url: string;
  api_key: string;
  created_at: number;
}

const adminUrl = process.env.MORA_ADMIN_URL ?? "https://mora.junx.dev";
const credentialFile = process.env.MORA_COLLECTOR_CREDENTIAL_FILE ?? resolve(process.cwd(), "Collector/.mora-collector.json");
process.stdout.write(`Collector 시작: ${adminUrl}\n`);
const storedCredentials = await readCredentials(credentialFile);
let adminToken = storedCredentials?.admin_url === adminUrl ? storedCredentials.api_key : undefined;

let initialConfig: CollectorRuntimeConfig | undefined;
if (adminToken !== undefined) {
  try {
    initialConfig = await fetchCollectorRuntimeConfig(adminUrl, adminToken);
  } catch (error) {
    if (!/COLLECTOR_CONFIG_(?:401|403)/u.test(error instanceof Error ? error.message : "")) throw error;
    adminToken = undefined;
  }
}

if (adminToken === undefined) {
  const pairing = await startCollectorPairing(adminUrl, `Collector on ${hostname()}`);
  const formattedPin = `${pairing.pin.slice(0, 3)} ${pairing.pin.slice(3, 6)} ${pairing.pin.slice(6)}`;
  process.stdout.write("\nCollector 인증이 필요합니다.\n");
  process.stdout.write(`Admin → 권한·설정 → Collector 연결에 PIN을 입력하세요: ${formattedPin}\n`);
  process.stdout.write("승인을 기다리는 중입니다…\n\n");
  adminToken = await waitForCollectorPairing(adminUrl, pairing);
  await saveCredentials(credentialFile, { admin_url: adminUrl, api_key: adminToken, created_at: Date.now() });
  process.stdout.write("Collector 인증 완료. 자격증명을 안전하게 저장했습니다.\n");
}
if (adminToken === undefined) throw new Error("COLLECTOR_AUTH_FAILED");
const collectorToken = adminToken;

async function loadProvider(config: CollectorRuntimeConfig): Promise<LyricsProvider> {
  if (config.lyricsLibraryModule !== undefined) {
    const loaded = (await import(config.lyricsLibraryModule)) as { default?: LyricsProvider; provider?: LyricsProvider };
    const provider = loaded.default ?? loaded.provider;
    if (provider === undefined || typeof provider.search !== "function")
      throw new Error("lyrics library must export a LyricsProvider as default or provider");
    return provider;
  }
  return createSongTitleProvider({
    ...(config.providers === undefined ? {} : { providers: config.providers }),
    timeoutMs: config.songTitleTimeoutMs,
    browser: config.songTitleBrowser ? { headless: !config.songTitleHeadful } : false,
    keys: {
      GENIUS_ACCESS_TOKEN: config.geniusAccessToken,
      LYRICFIND_API_KEY: config.lyricFindApiKey,
      LYRICFIND_TERRITORY: config.lyricFindTerritory,
    },
  });
}

async function run(config: CollectorRuntimeConfig): Promise<void> {
  let lastPrinted = 0;
  const service = new CollectorService({
    adminUrl,
    adminToken: collectorToken,
    userAgent: config.userAgent,
    dailyBudget: config.dailyBudget,
    markets: config.markets,
    lyricsProvider: await loadProvider(config),
    ...(config.spotifyClientId !== undefined && config.spotifyClientSecret !== undefined
      ? {
          spotify: new SpotifyClient(config.spotifyClientId, config.spotifyClientSecret, fetch, (message) =>
            process.stdout.write(`${message}\n`),
          ),
        }
      : {}),
    lyricfind: new LyricFindCatalogue(),
    onProgress: (progress) => {
      if (progress.stage === "discovering") {
        process.stdout.write(`차트 후보를 수집하는 중: ${progress.markets.join(", ")}\n`);
      } else if (progress.stage === "discovered") {
        const already = progress.alreadyCollected > 0 ? ` (이미 수집한 ${progress.alreadyCollected}곡 제외)` : "";
        process.stdout.write(`차트에서 ${progress.total}곡 확인${already}\n`);
      } else if (progress.stage === "selected") {
        process.stdout.write(`후보 ${progress.total}곡 선정. 한 곡씩 수집하고 즉시 Generator 작업으로 보냅니다.\n`);
      } else if (progress.stage === "delivered") {
        const destination = progress.destination === "generator" ? "Generator 전송 완료" : "Admin 검수로 이동";
        const why = progress.reason === undefined ? "" : ` (${progress.reason})`;
        const duplicate = progress.deduplicated ? " · 기존 작업" : "";
        process.stdout.write(`[${progress.current}/${progress.total}] ${destination}${why}${duplicate}: ${progress.song}\n`);
      } else if (progress.stage === "skipped") {
        const why =
          progress.reason === "instrumental"
            ? "연주곡"
            : progress.reason === "collected"
              ? "이미 수집함"
              : progress.reason === "no-source"
                ? "재생할 음원 없음"
                : "가사를 찾지 못함";
        process.stdout.write(`[${progress.current}/${progress.total}] 건너뜀 (${why}): ${progress.song}\n`);
      } else if (progress.stage === "failed") {
        process.stdout.write(`[${progress.current}/${progress.total}] 수집 실패 (${progress.code}): ${progress.song}\n`);
      } else if (progress.current === 1 || progress.current === progress.total || progress.current - lastPrinted >= 10) {
        lastPrinted = progress.current;
        process.stdout.write(`[${progress.current}/${progress.total}] 수집 중: ${progress.song}\n`);
      }
    },
  });
  const report = await service.run();
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

process.stdout.write("Admin에서 Collector 설정을 불러오는 중…\n");
let config = initialConfig ?? (await fetchCollectorRuntimeConfig(adminUrl, collectorToken));
process.stdout.write(
  `설정 완료: ${config.markets.join(", ")} · 최대 ${config.dailyBudget}곡 · ${config.once ? "1회 실행" : `${Math.round(config.intervalMs / 60_000)}분 간격`}` +
    ` · Spotify 식별 ${config.spotifyClientId !== undefined && config.spotifyClientSecret !== undefined ? "사용" : "미설정"}\n`,
);
// 수집과 나란히, 콘솔이 올린 음원 검색을 집어간다. 여러 대가 떠 있으면 먼저 집는 쪽이 처리한다.
startSearchWorker({
  adminUrl,
  adminToken: collectorToken,
  onLog: (message) => process.stdout.write(`${message}\n`),
});
process.stdout.write("Admin 음원 검색 대기 중\n");

let lastRunAt = Date.now();
await run(config);

while (!config.once) {
  const remaining = Math.max(1000, config.intervalMs - (Date.now() - lastRunAt));
  await delay(Math.min(60_000, remaining));
  config = await fetchCollectorRuntimeConfig(adminUrl, collectorToken);
  if (config.once) break;
  if (Date.now() - lastRunAt < config.intervalMs) continue;
  lastRunAt = Date.now();
  await run(config);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readCredentials(path: string): Promise<CollectorCredentials | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<CollectorCredentials>;
    if (typeof value.admin_url !== "string" || typeof value.api_key !== "string" || typeof value.created_at !== "number")
      throw new Error("invalid Collector credential file");
    return { admin_url: value.admin_url, api_key: value.api_key, created_at: value.created_at };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function saveCredentials(path: string, credentials: CollectorCredentials): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}
