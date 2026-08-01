import type { LyricsProvider } from "../../packages/contracts/src/index.js";
import { CollectorService } from "./service.js";
import { createSongTitleProviderFromEnv } from "./songtitle-provider.js";

async function loadProvider():Promise<LyricsProvider>{
  const modulePath=process.env.LYRICS_LIBRARY_MODULE;
  if(modulePath===undefined)return createSongTitleProviderFromEnv();
  const loaded=await import(modulePath) as {default?:LyricsProvider;provider?:LyricsProvider};const provider=loaded.default??loaded.provider;
  if(provider===undefined||typeof provider.search!=="function")throw new Error("lyrics library must export a LyricsProvider as default or provider");
  return provider;
}

const adminUrl=process.env.MORA_ADMIN_URL;const adminToken=process.env.MORA_COLLECTOR_TOKEN;
if(!adminUrl||!adminToken)throw new Error("MORA_ADMIN_URL and MORA_COLLECTOR_TOKEN are required");
const service=new CollectorService({adminUrl,adminToken,userAgent:process.env.MORA_USER_AGENT??"Mora/0.1 (admin@example.invalid)",dailyBudget:Number(process.env.COLLECTOR_DAILY_BUDGET??300),markets:["KR","US","JP"],lyricsProvider:await loadProvider()});
const interval=Math.max(60_000,Number(process.env.COLLECTOR_INTERVAL_MS??86_400_000));
async function run():Promise<void>{const report=await service.run();process.stdout.write(`${JSON.stringify(report)}\n`);}
await run();if(process.env.COLLECTOR_ONCE!=="1")setInterval(()=>void run(),interval);
