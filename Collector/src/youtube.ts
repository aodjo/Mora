import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RecordingSeed, YoutubeCandidate } from "./types.js";

const run=promisify(execFile);
interface YtEntry { id?:string;title?:string;track?:string;artist?:string;album?:string;duration?:number;uploader?:string;channel?:string;webpage_url?:string;categories?:string[];live_status?:string }

function normalize(value:string):string{return value.normalize("NFKC").toLowerCase().replace(/(?:official\s*)?(?:music\s*)?video|audio|lyrics?|topic/gu,"").replace(/[^\p{L}\p{N}]+/gu,"");}

export async function searchYoutubeMusic(seed:RecordingSeed):Promise<YoutubeCandidate[]> {
  const query=`${seed.artist} ${seed.title} ${seed.album??""} audio`;
  const {stdout}=await run("yt-dlp",["--dump-single-json","--flat-playlist","--no-warnings",`ytsearch10:${query}`],{maxBuffer:10*1024*1024});
  const parsed=JSON.parse(stdout) as {entries?:YtEntry[]};
  return (parsed.entries??[]).flatMap((entry):YoutubeCandidate[]=>{
    if(!entry.id||!entry.title||entry.live_status==="is_live")return[];
    const title=entry.track??entry.title;const artist=entry.artist??entry.uploader??entry.channel??"";
    if(/\b(?:live|cover|karaoke|instrumental|sped\s*up|slowed|remix)\b/iu.test(title))return[];
    if(/\b(?:official\s*)?(?:music\s*)?video\b/iu.test(entry.title))return[];
    const titleScore=normalize(title)===normalize(seed.title)?1:normalize(title).includes(normalize(seed.title))?0.8:0;
    const artistScore=normalize(artist).includes(normalize(seed.artist))||normalize(seed.artist).includes(normalize(artist))?1:0;
    const durationMs=Math.round((entry.duration??0)*1000);
    const durationScore=seed.duration_ms===undefined||durationMs===0?0.5:Math.max(0,1-Math.abs(seed.duration_ms-durationMs)/10_000);
    const official=/topic|official/iu.test(`${entry.uploader??""} ${entry.channel??""}`);
    const score=titleScore*.45+artistScore*.35+durationScore*.15+(official?0.05:0);
    if(score<.55)return[];
    return [{url:`https://music.youtube.com/watch?v=${entry.id}`,video_id:entry.id,title,artist,album:entry.album,duration_ms:durationMs,official,source_type:/topic/iu.test(`${entry.uploader??""} ${entry.channel??""}`)?"topic":official?"song":"unofficial",score}];
  }).sort((a,b)=>b.score-a.score).slice(0,3);
}
