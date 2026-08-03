import { ServiceError } from "../../../packages/core/src/shared/errors.js";

export function youtubeVideoId(value:string):string {
  let url:URL;
  try { url=new URL(value); }
  catch { throw new ServiceError(400,"INVALID_REQUEST"); }
  if(url.protocol!=="https:")throw new ServiceError(400,"INVALID_REQUEST");
  const host=url.hostname.replace(/^www\./u,"");
  const id=host==="youtu.be"
    ? url.pathname.split("/").filter(Boolean)[0]??null
    : host==="youtube.com"||host==="music.youtube.com"||host==="m.youtube.com"
      ? url.searchParams.get("v")
      : null;
  if(id===null||!/^[A-Za-z0-9_-]{11}$/u.test(id))throw new ServiceError(400,"INVALID_REQUEST");
  return id;
}

export function normalizeIsrc(value:string):string {
  const normalized=value.replaceAll("-","").trim().toUpperCase();
  if(!/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/u.test(normalized))throw new ServiceError(400,"INVALID_REQUEST");
  return normalized;
}

export function resolveLyricLanguage(requested:string,lyrics:string):"ko"|"en"|"ja" {
  if(requested!=="auto"){
    if(requested==="ko"||requested==="en"||requested==="ja")return requested;
    throw new ServiceError(400,"INVALID_REQUEST");
  }
  if(/\p{Script=Hangul}/u.test(lyrics))return"ko";
  if(/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(lyrics))return"ja";
  return"en";
}
