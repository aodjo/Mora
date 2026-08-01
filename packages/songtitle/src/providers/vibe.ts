import type { LyricLine, Provider } from "../types.js";
import { getJson, type HttpOptions } from "../http.js";
import { plainFrom } from "../util/lyrics.js";

const API = "https://apis.naver.com/vibeWeb/musicapiweb";

interface VibeSearchResp {
  response?: { result?: { tracks?: Array<{ trackId?: number | string }> } };
}
interface VibeLyricResp {
  response?: {
    result?: {
      lyric?: {
        normalLyric?: { text?: string };
        syncLyric?: { lyricLine?: Array<{ startTimeMillis?: number; text?: string }> };
      };
    };
  };
}

/**
 * Vibe (Naver) — musicapiweb JSON API. 검색 후 lyric 엔드포인트에서
 * normalLyric(평문) + syncLyric(싱크)를 받는다.
 */
export const vibe: Provider = {
  name: "vibe",
  async fetch(query, ctx) {
    const opts: HttpOptions = {
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      fetchImpl: ctx.fetchImpl,
      headers: { Referer: "https://vibe.naver.com/", Accept: "application/json" },
    };
    const q = [query.title, query.artist].filter(Boolean).join(" ");

    let trackId = query.trackId;
    if (!trackId) {
      const search = await getJson<VibeSearchResp>(
        `${API}/v3/search/track?query=${encodeURIComponent(q)}` +
          `&start=1&display=10&sort=RELEVANCE`,
        opts,
      );
      trackId = search.response?.result?.tracks?.[0]?.trackId?.toString();
    }
    if (!trackId) return null;

    const lyr = await getJson<VibeLyricResp>(`${API}/v3/lyric/${trackId}`, opts);
    const lyric = lyr.response?.result?.lyric ?? {};

    let synced: LyricLine[] | undefined;
    const syncLines = lyric.syncLyric?.lyricLine;
    if (Array.isArray(syncLines) && syncLines.length) {
      synced = syncLines.map((l) => ({
        timeMs: Number(l.startTimeMillis ?? 0),
        text: l.text ?? "",
      }));
    }

    const lyrics = plainFrom(lyric.normalLyric?.text, synced);
    if (!lyrics) return null;

    return {
      provider: "vibe",
      title: query.title,
      artist: query.artist,
      lyrics,
      synced: synced && synced.length ? synced : undefined,
      url: `https://vibe.naver.com/track/${trackId}`,
      trackId,
    };
  },
};
