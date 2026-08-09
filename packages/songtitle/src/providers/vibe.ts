import type { LyricLine, Provider } from "../types.js";
import { getJson, type HttpOptions } from "../http.js";
import { plainFrom } from "../util/lyrics.js";
import { pickTrack } from "../util/match.js";

const API = "https://apis.naver.com/vibeWeb/musicapiweb";

interface VibeTrack {
  trackId?: number | string;
  trackTitle?: string;
  artists?: Array<{ artistName?: string }>;
  album?: { albumTitle?: string };
}
interface VibeSearchResp {
  response?: { result?: { tracks?: VibeTrack[] } };
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
 * Vibe (Naver) — musicapiweb JSON API. 검색 결과의 trackTitle·artistName으로 질의와
 * 일치하는 트랙을 고른 뒤 lyric 엔드포인트에서 normalLyric(평문) + syncLyric(싱크)를 받는다.
 * 첫 트랙을 검증 없이 집으면 같은 제목의 다른 곡·무관한 곡이 질의 제목을 달고 나간다.
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
    let matched: VibeTrack | undefined;
    if (!trackId) {
      const search = await getJson<VibeSearchResp>(
        `${API}/v3/search/track?query=${encodeURIComponent(q)}` + `&start=1&display=10&sort=RELEVANCE`,
        opts,
      );
      matched = pickTrack(search.response?.result?.tracks ?? [], query, (track) => ({
        title: track.trackTitle,
        artist: (track.artists ?? []).map((artist) => artist.artistName ?? "").join(", "),
      }));
      trackId = matched?.trackId?.toString();
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

    const credited = (matched?.artists ?? []).map((artist) => artist.artistName ?? "").filter(Boolean);
    return {
      provider: "vibe",
      title: matched?.trackTitle ?? query.title,
      artist: credited.length ? credited.join(", ") : query.artist,
      album: matched?.album?.albumTitle,
      lyrics,
      synced: synced && synced.length ? synced : undefined,
      url: `https://vibe.naver.com/track/${trackId}`,
      trackId,
    };
  },
};
