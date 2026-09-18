import type { Provider } from "../types.js";
import { bugs } from "./bugs.js";
import { genie } from "./genie.js";
import { flo } from "./flo.js";
import { vibe } from "./vibe.js";
import { genius } from "./genius.js";
import { lyricfind } from "./lyricfind.js";
import { shazam } from "./shazam.js";

/** 등록된 모든 프로바이더 (라우터 기본값) */
//: melon 은 뺐다 — 다른 네 곳이 같은 가사를 주고, 검색 화면 마크업이 요청에 따라
//: `<tr>` 로도 `<li>` 로도 와서 읽는 쪽이 제일 자주 흔들렸다.
export const allProviders: Provider[] = [
  bugs,
  genie,
  flo,
  vibe,
  genius,
  shazam,
  lyricfind, // 브라우저 큐에서 맨 뒤 (captcha로 timeout 나므로 다른 브라우저 프로바이더를 막지 않게)
];

/** 이름으로 프로바이더 조회 */
export const providerByName: Record<string, Provider> = Object.fromEntries(allProviders.map((p) => [p.name, p]));

export { bugs, genie, flo, vibe, genius, lyricfind, shazam };
