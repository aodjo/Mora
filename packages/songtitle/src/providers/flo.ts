import type { LyricLine, Provider } from "../types.js";
import { getJson, type HttpOptions } from "../http.js";
import { parseLrc, plainFrom } from "../util/lyrics.js";

const BASE = "https://www.music-flo.com";

interface FloSearchResp {
  data?: { list?: Array<{ type?: string; list?: Array<{ id?: number | string }> }> };
}
interface FloTrackResp {
  data?: {
    name?: string;
    lyrics?: string;
    lyricsList?: Array<{ text?: string; timeMillis?: number; time?: number }>;
  };
}

/**
 * FLO — JSON 검색 API로 trackId를 얻고, 트랙 상세(/api/meta/v1/track/{id})의
 * lyrics 필드에서 가사를 받는다. lyrics 안에 LRC 타임태그가 있으면 싱크로 파싱.
 * (검색은 keyword 파라미터만 붙여야 결과가 나온다 — 부가 파라미터는 빈 결과)
 */
export const flo: Provider = {
  name: "flo",
  async fetch(query, ctx) {
    const opts: HttpOptions = {
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      fetchImpl: ctx.fetchImpl,
      headers: { Referer: `${BASE}/`, Accept: "application/json" },
    };
    const q = [query.title, query.artist].filter(Boolean).join(" ");

    let trackId = query.trackId;
    if (!trackId) {
      const search = await getJson<FloSearchResp>(
        `${BASE}/api/search/v2/search?keyword=${encodeURIComponent(q)}`,
        opts,
      );
      const groups = search.data?.list ?? [];
      const trackGroup = groups.find((g) => g.type === "TRACK") ?? groups[0];
      trackId = trackGroup?.list?.[0]?.id?.toString();
    }
    if (!trackId) return null;

    const meta = await getJson<FloTrackResp>(
      `${BASE}/api/meta/v1/track/${trackId}`,
      opts,
    );
    const data = meta.data ?? {};

    let synced: LyricLine[] | undefined;
    if (Array.isArray(data.lyricsList) && data.lyricsList.length) {
      synced = data.lyricsList.map((l) => ({
        timeMs: Number(l.timeMillis ?? l.time ?? 0),
        text: l.text ?? "",
      }));
    } else if (data.lyrics && /\[\d{1,2}:\d{2}/.test(data.lyrics)) {
      synced = parseLrc(data.lyrics);
    }

    const lyrics = plainFrom(data.lyrics?.replace(/\[[^\]]*\]/g, "").trim(), synced);
    if (!lyrics) return null;

    return {
      provider: "flo",
      title: data.name ?? query.title,
      artist: query.artist,
      lyrics,
      synced: synced && synced.length ? synced : undefined,
      url: `${BASE}/detail/track/${trackId}/detailinfo`,
      trackId,
    };
  },
};
