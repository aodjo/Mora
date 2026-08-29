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
        /**
         * 나란한 두 배열이다 — `startTimeIndex[i]`(초, 실수)가 `contents[0].text[i]`와 짝이다.
         *
         * 앞서 이 자리는 `lyricLine: [{ startTimeMillis, text }]` 로 적혀 있었는데 그 모양은
         * 이제 오지 않는다. `hasSyncLyric` 은 여전히 true 로 오므로 깃발만 보아서는 알 수
         * 없었고, 싱크가 조용히 사라진 채로 돌고 있었다. 여덟 곡을 쳐 보니 여덟 곡 모두
         * 새 모양으로 왔고 두 배열의 길이도 모두 맞았다.
         */
        syncLyric?: {
          startTimeIndex?: number[];
          contents?: Array<{ languageType?: string; text?: string[] }>;
        };
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
    const times = lyric.syncLyric?.startTimeIndex;
    // 언어가 여럿일 수 있다. 원문(default)을 쓰고, 그것이 없으면 첫 번째를 쓴다.
    const contents = lyric.syncLyric?.contents ?? [];
    const body = (contents.find((one) => one.languageType === "default") ?? contents[0])?.text;
    if (Array.isArray(times) && Array.isArray(body) && times.length > 0) {
      // 길이가 어긋나면 짧은 쪽까지만 쓴다. 짝이 없는 시각은 붙일 글자가 없다.
      const upto = Math.min(times.length, body.length);
      synced = Array.from({ length: upto }, (_, index) => ({
        timeMs: Math.round(Number(times[index] ?? 0) * 1000),
        text: body[index] ?? "",
      })).filter((line) => line.text.trim().length > 0);
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
