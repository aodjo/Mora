import type { LyricsProviderResult } from "../../packages/contracts/src/index.js";
import { ListenBrainzClient } from "./listenbrainz.js";
import { MusicBrainzClient } from "./musicbrainz.js";
import type { CollectorConfig, RecordingSeed } from "./types.js";
import { searchYoutubeMusic } from "./youtube.js";

export interface CollectionReport { discovered:number;identified:number;submitted:number;review:number;errors:Array<{song:string;code:string}> }

export class CollectorService {
  readonly #fetch:typeof fetch;readonly #musicbrainz:MusicBrainzClient;readonly #listenbrainz:ListenBrainzClient;
  constructor(readonly config:CollectorConfig){this.#fetch=config.fetch??fetch;this.#musicbrainz=new MusicBrainzClient(config.userAgent,this.#fetch);this.#listenbrainz=new ListenBrainzClient(this.#fetch);}

  async run():Promise<CollectionReport>{
    const report:CollectionReport={discovered:0,identified:0,submitted:0,review:0,errors:[]};
    const pools:RecordingSeed[]=[];
    for(const market of this.config.markets){
      const [popular,fresh]=await Promise.all([this.#listenbrainz.popular(market,100).catch(()=>[]),this.#musicbrainz.fresh(market,14,100).catch(()=>[])]);
      pools.push(...popular,...fresh);
    }
    const unique=new Map<string,RecordingSeed>();
    for(const seed of pools){const key=`${seed.artist.normalize("NFKC").toLowerCase()}\0${seed.title.normalize("NFKC").toLowerCase()}`;const old=unique.get(key);if(old===undefined)unique.set(key,seed);else unique.set(key,{...old,popularity:Math.max(old.popularity,seed.popularity),freshness:Math.max(old.freshness,seed.freshness)});}
    const ranked=[...unique.values()].sort((a,b)=>(b.popularity*.65+b.freshness*.35)-(a.popularity*.65+a.freshness*.35)).slice(0,this.config.dailyBudget);report.discovered=ranked.length;
    for(const seed of ranked){
      try{
        const identified=await this.#musicbrainz.identify(seed);if(identified.isrc)report.identified++;
        const sources=await (this.config.youtubeSearch??searchYoutubeMusic)(identified);
        const lyrics:LyricsProviderResult[]=identified.isrc?await this.config.lyricsProvider.search({isrc:identified.isrc,...identified.mbid?{mbid:identified.mbid}:{},artist:identified.artist,title:identified.title,...identified.album?{album:identified.album}:{}}):[];
        const selected=sources[0]?.official===true&&sources[0].score>=.9;
        const response=await this.#fetch(`${this.config.adminUrl.replace(/\/$/u,"")}/admin/api/collector/recordings`,{method:"POST",headers:{authorization:`Bearer ${this.config.adminToken}`,"content-type":"application/json"},body:JSON.stringify({recording:identified,sources:sources.map((source,index)=>({...source,rank:index+1,selected:selected&&index===0})),lyrics,priority:identified.popularity*.65+identified.freshness*.35})});
        if(!response.ok)throw new Error(`ADMIN_${response.status}`);const result=await response.json() as {job_id?:string|null};if(result.job_id)report.submitted++;else report.review++;
      }catch(error){report.errors.push({song:`${seed.artist} - ${seed.title}`,code:error instanceof Error?error.message:"UNKNOWN"});}
    }
    return report;
  }
}
