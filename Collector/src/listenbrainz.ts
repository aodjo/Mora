import type { RecordingSeed } from "./types.js";

interface TopRecording {
  track_name?: string;
  artist_name?: string;
  release_name?: string;
  recording_mbid?: string;
  listen_count?: number;
}

export class ListenBrainzClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async popular(market: "KR" | "US" | "JP", count = 100): Promise<RecordingSeed[]> {
    const url = new URL("https://api.listenbrainz.org/1/stats/sitewide/recordings");
    url.searchParams.set("range", "this_week");
    url.searchParams.set("count", String(Math.min(100, count)));
    const response = await this.fetcher(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`LISTENBRAINZ_${response.status}`);
    const payload = (await response.json()) as { payload?: { recordings?: TopRecording[] } };
    const rows = payload.payload?.recordings ?? [];
    const max = Math.max(1, ...rows.map((x) => x.listen_count ?? 0));
    return rows.flatMap((item): RecordingSeed[] =>
      item.track_name && item.artist_name
        ? [
            {
              artist: item.artist_name,
              title: item.track_name,
              album: item.release_name,
              mbid: item.recording_mbid,
              popularity: (item.listen_count ?? 0) / max,
              freshness: 0,
              market,
            },
          ]
        : [],
    );
  }
}
