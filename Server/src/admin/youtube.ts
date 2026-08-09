import { ServiceError } from "../../../packages/core/src/shared/errors.js";

const SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";

export interface YoutubeSearchResult {
  video_id: string;
  title: string;
  channel: string;
  duration_ms: number;
  thumbnail: string;
  published_at: string;
}

interface SearchResponse {
  items?: Array<{
    id?: { videoId?: string };
    snippet?: {
      title?: string;
      channelTitle?: string;
      publishedAt?: string;
      thumbnails?: { medium?: { url?: string }; default?: { url?: string } };
    };
  }>;
}

interface VideosResponse {
  items?: Array<{ id?: string; contentDetails?: { duration?: string } }>;
}

/**
 * ISO 8601 duration as the Data API returns it — "PT4M13S". Anything without a length is a
 * live stream or a premiere, and a length is the one thing the reviewer most needs to see.
 */
export function parseIsoDuration(value: string | undefined): number {
  if (value === undefined) return 0;
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/u.exec(value);
  if (match === null) return 0;
  const [, days, hours, minutes, seconds] = match;
  return Math.round(((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)) * 1000);
}

/**
 * Search is the one thing the collector's yt-dlp cannot do from a Worker, so the reviewer's
 * search goes through the Data API instead. Two calls: search gives ids and titles, videos
 * gives the durations, which search omits and which decide whether a result is the recording.
 */
export async function searchYoutube(apiKey: string, query: string, fetcher: typeof fetch = fetch): Promise<YoutubeSearchResult[]> {
  const search = new URL(SEARCH_URL);
  search.searchParams.set("key", apiKey);
  search.searchParams.set("part", "snippet");
  search.searchParams.set("type", "video");
  search.searchParams.set("maxResults", "12");
  search.searchParams.set("videoCategoryId", "10");
  search.searchParams.set("q", query);
  const response = await fetcher(search);
  if (!response.ok) throw new ServiceError(response.status === 403 ? 402 : 502, "YOUTUBE_SEARCH_FAILED");
  const found = ((await response.json()) as SearchResponse).items ?? [];

  const ids = found.flatMap((item) => (typeof item.id?.videoId === "string" ? [item.id.videoId] : []));
  if (ids.length === 0) return [];

  const videos = new URL(VIDEOS_URL);
  videos.searchParams.set("key", apiKey);
  videos.searchParams.set("part", "contentDetails");
  videos.searchParams.set("id", ids.join(","));
  const details = await fetcher(videos);
  const durations = new Map<string, number>();
  if (details.ok)
    for (const item of ((await details.json()) as VideosResponse).items ?? [])
      if (typeof item.id === "string") durations.set(item.id, parseIsoDuration(item.contentDetails?.duration));

  return found.flatMap((item): YoutubeSearchResult[] => {
    const videoId = item.id?.videoId;
    const snippet = item.snippet;
    if (typeof videoId !== "string" || snippet === undefined) return [];
    return [
      {
        video_id: videoId,
        title: decodeEntities(snippet.title ?? videoId),
        channel: decodeEntities(snippet.channelTitle ?? ""),
        duration_ms: durations.get(videoId) ?? 0,
        thumbnail: snippet.thumbnails?.medium?.url ?? snippet.thumbnails?.default?.url ?? "",
        published_at: snippet.publishedAt ?? "",
      },
    ];
  });
}

/** The API returns titles with HTML entities in them: "Don&#39;t Stop". */
function decodeEntities(value: string): string {
  return value.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
}
