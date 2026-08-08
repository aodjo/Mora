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
 * 웹사이트(lyrics.lyricfind.com)는 검색·가사 페이지 전체가 CAPTCHA 퍼즐로 보호되어
 * 브라우저 크롤링으로는 통과할 수 없으므로 브라우저 폴백을 제공하지 않는다
 * (browserCapable 아님 → 키가 없으면 라우터가 skip).
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
