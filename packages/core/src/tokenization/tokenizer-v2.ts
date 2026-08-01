import { TOKENIZER_V2, type Token, type TokenType, type Tokenization, type TokenizedLine } from "../shared/types.js";

const punctuation = /^\p{P}+$/u;
const sectionHeader = /^\s*[\[(](?:verse|pre-?chorus|chorus|bridge|hook|intro|outro|interlude|refrain|후렴|간주|도입|벌스|코러스|브릿지|サビ|イントロ|アウトロ)(?:\s+[^\])]+)?[\])]\s*$/iu;

function typeOf(value: string): TokenType {
  if (/^(?:\p{Script=Hangul}|\p{M})+$/u.test(value)) return 0;
  if (/^(?:\p{Script=Latin}|\p{M})+$/u.test(value)) return 1;
  if (/^\p{N}+$/u.test(value)) return 2;
  return 3;
}

function japaneseClass(char:string):string {
  if (/^\p{Script=Han}$/u.test(char)) return "han";
  if (/^\p{Script=Hiragana}$/u.test(char)) return "hiragana";
  if (/^\p{Script=Katakana}$/u.test(char)) return "katakana";
  if (/^\p{Script=Latin}$/u.test(char)) return "latin";
  if (/^\p{N}$/u.test(char)) return "number";
  if (/^\p{M}$/u.test(char)) return "mark";
  return "other";
}

function segmentJapanese(line:string):Array<{value:string;start:number;end:number}>{
  const points=Array.from(line);const output:Array<{value:string;start:number;end:number}>=[];let start=-1;let previous="";
  const flush=(end:number):void=>{if(start<0)return;const raw=points.slice(start,end).join("");const value=raw.replace(/^\p{P}+|\p{P}+$/gu,"");if(value.length>0){const trim=Array.from(raw).findIndex(char=>!punctuation.test(char));const offset=start+Math.max(0,trim);output.push({value:value.normalize("NFC").toLocaleLowerCase("und"),start:offset,end:offset+Array.from(value).length});}start=-1;previous="";};
  for(let index=0;index<=points.length;index+=1){const char=points[index];if(char===undefined||/^\s$/u.test(char)||punctuation.test(char)){flush(index);continue;}const current=japaneseClass(char);if(start<0){start=index;previous=current;continue;}const compatible=current==="mark"||current===previous||(previous==="latin"&&current==="number")||(previous==="number"&&current==="latin");if(!compatible){flush(index);start=index;}previous=current;}
  return output;
}

function segments(line: string, language: string): Array<{ value: string; start: number; end: number }> {
  const hasJapanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(line);
  if (hasJapanese || language.toLowerCase().startsWith("ja")) {
    return segmentJapanese(line);
  }
  const output: Array<{ value: string; start: number; end: number }> = [];
  const points = Array.from(line);
  let start = -1;
  for (let index = 0; index <= points.length; index += 1) {
    const char = points[index];
    if (char !== undefined && !/^\s$/u.test(char)) {
      if (start < 0) start = index;
      continue;
    }
    if (start < 0) continue;
    const raw = points.slice(start, index).join("");
    const value = raw.replace(/^\p{P}+|\p{P}+$/gu, "");
    const left = Array.from(raw).findIndex((point) => !punctuation.test(point));
    if (value.length > 0) output.push({ value: value.normalize("NFC").toLocaleLowerCase("und"), start: start + Math.max(0, left), end: start + Math.max(0, left) + Array.from(value).length });
    start = -1;
  }
  return output;
}

export function tokenizeV2(text: string, language = "und"): Tokenization {
  const normalized = text.replace(/\r\n?/gu, "\n");
  const rawLines = normalized.split("\n");
  const tokens: Token[] = [];
  const lines: TokenizedLine[] = [];
  let cursor = 0;
  rawLines.forEach((lineText, lineIndex) => {
    const lineLength = Array.from(lineText).length;
    const excluded = sectionHeader.test(lineText);
    const tokenIndices: number[] = [];
    if (!excluded) {
      for (const segment of segments(lineText, language)) {
        tokenIndices.push(tokens.length);
        tokens.push({ start: cursor + segment.start, end: cursor + segment.end, line: lineIndex, length: Array.from(segment.value).length, type: typeOf(segment.value), canonical: segment.value });
      }
    }
    lines.push({ index: lineIndex, start: cursor, end: cursor + lineLength, tokenIndices, excluded });
    cursor += lineLength + 1;
  });
  const canonical = lines.filter((line) => !line.excluded && line.tokenIndices.length > 0).map((line) => line.tokenIndices.map((index) => tokens[index]?.canonical ?? "").join(" ")).join("\n");
  return { tokenizer: TOKENIZER_V2, tokens, lines, canonical };
}
