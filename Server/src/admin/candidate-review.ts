import { tokenizeV2 } from "../../../packages/core/src/tokenization/tokenizer-v2.js";

export interface ReviewToken {
  index:number;
  text:string;
  line:number;
  speaker_id:number|null;
  speaker_confidence:number|null;
}

export interface ReviewLine {
  index:number;
  text:string;
  token_indices:number[];
}

export function buildReviewLyrics(text:string,language:string,wordSpeakers:Array<[number,number,number]>):{tokens:ReviewToken[];lines:ReviewLine[]}{
  const tokenization=tokenizeV2(text,language);const points=Array.from(text);const speakers=new Map<number,{id:number;confidence:number}>();
  for(const [token,speaker,confidence] of wordSpeakers){const current=speakers.get(token);if(current===undefined||confidence>current.confidence)speakers.set(token,{id:speaker,confidence});}
  return{
    tokens:tokenization.tokens.map((token,index)=>{const speaker=speakers.get(index);return{index,text:points.slice(token.start,token.end).join(""),line:token.line,speaker_id:speaker?.id??null,speaker_confidence:speaker?.confidence??null};}),
    lines:tokenization.lines.filter(line=>!line.excluded&&line.tokenIndices.length>0).map(line=>({index:line.index,text:points.slice(line.start,line.end).join(""),token_indices:line.tokenIndices})),
  };
}
