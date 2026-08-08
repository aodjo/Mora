import type { Provider } from "../types.js";
import { melon } from "./melon.js";
import { bugs } from "./bugs.js";
import { genie } from "./genie.js";
import { flo } from "./flo.js";
import { vibe } from "./vibe.js";
import { genius } from "./genius.js";
import { lyricfind } from "./lyricfind.js";
import { shazam } from "./shazam.js";

/** 등록된 모든 프로바이더 (라우터 기본값) */
export const allProviders: Provider[] = [
  melon,
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

export { melon, bugs, genie, flo, vibe, genius, lyricfind, shazam };
