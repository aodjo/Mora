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
