import assert from "node:assert/strict";
import test from "node:test";
import { resolveDurationMs } from "../Collector/src/service.js";
import type { RecordingSeed, YoutubeCandidate } from "../Collector/src/types.js";

const seed:RecordingSeed={artist:"Artist",title:"Song",popularity:1,freshness:0,market:"KR"};
const source:YoutubeCandidate={url:"https://music.youtube.com/watch?v=abcdefghijk",video_id:"abcdefghijk",title:"Song",artist:"Artist",duration_ms:183_400,official:true,source_type:"topic",score:.95};

test("Collector fills a missing recording duration from the selected media candidate",()=>{
  assert.equal(resolveDurationMs(seed,[source]),183_400);
});

test("Collector keeps an identified MusicBrainz duration",()=>{
  assert.equal(resolveDurationMs({...seed,duration_ms:181_234},[source]),181_234);
  assert.equal(resolveDurationMs(seed,[]),undefined);
});
