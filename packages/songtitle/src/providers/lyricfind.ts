import type { LyricsResult, Provider, ProviderContext, SearchQuery } from "../types.js";
import { getJson, type HttpOptions } from "../http.js";

interface LyricFindResp {
  track?: {
    lyrics?: string;
    title?: string;
    artist?: { name?: string };
    album?: { title?: string };
    lfid?: string;
  };
}

/**
 * LyricFind — 라이선스 API(lyric.do) 전용. `LYRICFIND_API_KEY` 필수.
 *
 * "웹을 뜯으면 되지 않나"는 확인해봤고, 안 된다 (2026-08 측정):
 *  - api.lyricfind.com/search.do, /lyric.do 는 키 없이 호출하면 HTTP 200 본문에
 *    `{"code":200,"description":"NOT AUTHORIZED","message":"An apikey is required."}` 를 준다.
 *  - lyrics.lyricfind.com 은 홈·차트·아티스트·browse 는 200으로 열리지만,
 *    가사 본문 경로 `/lyrics/*` 만 AWS WAF 뒤에 있다 — 응답이 `HTTP 202`,
 *    `x-amzn-waf-action: challenge`, 본문 0바이트. 즉 사이트 전체가 아니라
 *    "가사만" 골라 막아둔 것이다. 통과하려면 WAF 챌린지 토큰을 발급받아야 하는데
 *    그건 보호장치 우회라 하지 않는다.
 *  - 모든 페이지에 `<meta name="tdm-reservation" content="1">` — 기계 수집 거부를
 *    기계가 읽을 수 있게 명시해둔 태그다. 크롤링은 이 의사에 반한다.
 *
 * 그래서 브라우저 폴백을 제공하지 않는다 (browserCapable 아님 → 키가 없으면 라우터가 skip).
 * 이 프로바이더를 살리는 길은 LyricFind와 라이선스 계약을 맺고 키를 받는 것뿐이다.
 */
export const lyricfind: Provider = {
  name: "lyricfind",
  requiresKey: true,
  keyName: "LYRICFIND_API_KEY",
  async fetch(query, ctx) {
    const key = ctx.keys.LYRICFIND_API_KEY;
    if (!key) throw new Error("missing LYRICFIND_API_KEY");
    return lyricfindViaApi(query, ctx, key);
  },
};

async function lyricfindViaApi(query: SearchQuery, ctx: ProviderContext, key: string): Promise<LyricsResult | null> {
  const opts: HttpOptions = {
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
    fetchImpl: ctx.fetchImpl,
  };
  const territory = ctx.keys.LYRICFIND_TERRITORY ?? "US";
  const params = new URLSearchParams({
    apikey: key,
    reqtype: "default",
    territory,
    output: "json",
    trackid: `artist:${query.artist ?? ""},title:${query.title}`,
  });

  const data = await getJson<LyricFindResp>(`https://api.lyricfind.com/lyric.do?${params.toString()}`, opts);
  const track = data.track;
  if (!track?.lyrics) return null;

  return {
    provider: "lyricfind",
    title: track.title,
    artist: track.artist?.name,
    album: track.album?.title,
    lyrics: track.lyrics,
    url: track.lfid ? `https://lyrics.lyricfind.com/lyrics/${track.lfid}` : undefined,
    trackId: track.lfid,
  };
}
