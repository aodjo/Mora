#!/usr/bin/env node
import { LyricsRouter } from "./router.js";
import { allProviders, providerByName } from "./providers/index.js";
import { formatTime } from "./util/lyrics.js";
import type { ProviderOutcome } from "./types.js";

interface Args {
  title?: string;
  artist?: string;
  providers?: string;
  timeout?: string;
  json?: boolean;
  synced?: boolean;
  browser?: boolean;
  headful?: boolean;
  help?: boolean;
  _: string[];
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue;
    else if (a === "--json") out.json = true;
    else if (a === "--synced") out.synced = true;
    else if (a === "--browser") out.browser = true;
    else if (a === "--headful" || a === "--no-headless") out.headful = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a === "-t" || a === "--title") out.title = argv[++i];
    else if (a === "-a" || a === "--artist") out.artist = argv[++i];
    else if (a === "-p" || a === "--providers") out.providers = argv[++i];
    else if (a === "--timeout") out.timeout = argv[++i];
    else if (a.startsWith("--title=")) out.title = a.slice(8);
    else if (a.startsWith("--artist=")) out.artist = a.slice(9);
    else if (a.startsWith("--providers=")) out.providers = a.slice(12);
    else if (a.startsWith("--timeout=")) out.timeout = a.slice(10);
    else out._.push(a);
  }
  if (!out.title && out._.length) out.title = out._.join(" ");
  return out;
}

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function statusTag(o: ProviderOutcome): string {
  switch (o.status) {
    case "ok":
      return c.green("✓ ok");
    case "not_found":
      return c.yellow("· not found");
    case "skipped":
      return c.dim(`- skipped (${o.error})`);
    case "error":
      return c.red(`✗ error (${o.error})`);
  }
}

function printHelp(): void {
  const names = allProviders.map((p) => p.name).join(", ");
  console.log(`lyrics-router — 여러 서비스에서 가사를 한 번에 가져옵니다

사용법:
  lyrics-router "<제목>" [-a "<아티스트>"] [옵션]
  lyrics-router -t "<제목>" -a "<아티스트>" [옵션]

옵션:
  -t, --title <제목>        곡 제목 (위치 인자로도 가능)
  -a, --artist <아티스트>   아티스트명 (검색 정확도 ↑)
  -p, --providers <a,b,c>   사용할 프로바이더만 지정 (기본: 전체)
      --timeout <초>        프로바이더별 타임아웃 (기본 12)
      --synced              타임 싱크 가사를 [mm:ss.xx]로 표시
      --browser             HTTP로 못 가져오는 프로바이더를 헤드리스 Chromium으로 크롤링
                            (genius/shazam — 키 없이도 시도)
      --headful             브라우저를 화면에 띄워 실행 (디버깅/일부 사이트에 유리, --browser와 함께)
      --json                결과를 JSON으로 출력
  -h, --help               이 도움말

프로바이더: ${names}
키 필요: genius(GENIUS_ACCESS_TOKEN) — 없으면 곡 URL을 조립해 읽는 폴백으로 동작하지만
         라틴 문자 제목만 닿는다. 일본어/한국어 곡까지 받으려면 토큰이 필요하다(무료 발급).
         lyricfind(LYRICFIND_API_KEY) — 가사 경로가 AWS WAF로 막혀 있어 키 필수 (없으면 skip)
         shazam — SONGTITLE_BROWSER=1(--browser) 없이는 동작 불가

예:
  lyrics-router "너를 처음 본 순간" -a "검정치마"
  lyrics-router -t Magenta -p melon,genie,vibe --synced
  lyrics-router "Bohemian Rhapsody" -a Queen --browser   # genius 등 브라우저 폴백`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.title) {
    printHelp();
    process.exit(args.title ? 0 : 1);
  }

  const only = args.providers
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const providers = only?.length ? only.map((n) => providerByName[n]).filter((p): p is NonNullable<typeof p> => Boolean(p)) : allProviders;

  if (only?.length && providers.length === 0) {
    console.error(c.red(`알 수 없는 프로바이더: ${only.join(", ")}`));
    console.error(`사용 가능: ${allProviders.map((p) => p.name).join(", ")}`);
    process.exit(1);
  }

  const router = new LyricsRouter({
    providers,
    timeoutMs: args.timeout ? Number(args.timeout) * 1000 : undefined,
    browser: args.browser ? { headless: !args.headful } : false,
  });

  const query = { title: args.title, artist: args.artist };
  console.error(
    c.dim(`검색: ${c.bold(query.title)}${query.artist ? " — " + query.artist : ""} ` + `(${router.list().length}개 프로바이더)`),
  );

  const res = await router.fetchAll(query);

  if (args.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  // 상태 요약
  console.error("");
  for (const o of res.outcomes) {
    console.error(`  ${o.provider.padEnd(10)} ${statusTag(o)} ${c.dim(`${o.elapsedMs}ms`)}`);
  }
  console.error("");

  if (res.results.length === 0) {
    console.error(c.yellow("가사를 찾지 못했습니다."));
    process.exit(2);
  }

  // 가사 본문 출력
  for (const r of res.results) {
    const header = [r.title, r.artist].filter(Boolean).join(" — ") || "(제목 미상)";
    console.log(c.bold(c.cyan(`\n══ ${r.provider} ══ `)) + c.bold(header));
    if (r.album) console.log(c.dim(`앨범: ${r.album}`));
    if (r.url) console.log(c.dim(r.url));
    console.log("");

    if (args.synced && r.synced?.length) {
      for (const line of r.synced) {
        console.log(`${c.dim(`[${formatTime(line.timeMs)}]`)} ${line.text}`);
      }
    } else {
      console.log(r.lyrics);
    }
  }
}

main().catch((err) => {
  console.error(c.red(`오류: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
