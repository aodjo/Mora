import type { LyricsProvider, LyricsProviderResult } from "../../packages/contracts/src/index.js";
import { ListenBrainzClient } from "./listenbrainz.js";
import { MusicBrainzClient } from "./musicbrainz.js";
import type { CollectorConfig, RecordingSeed, YoutubeCandidate } from "./types.js";
import { searchYoutubeMusic } from "./youtube.js";

export interface CollectionReport {
  discovered: number;
  identified: number;
  submitted: number;
  review: number;
  skipped: number;
  errors: Array<{ song: string; code: string }>;
}

/**
 * A track that announces it has no vocal to align. MR only counts inside brackets — bare "mr"
 * is Mr. Blue Sky, not a backing track.
 */
const INSTRUMENTAL = /\b(?:instrumental|inst\.?|off\s*vocal|karaoke)\b|[([]\s*(?:inst|mr)\s*[)\]]|반주/iu;

export function hasNoLyricsToAlign(seed: RecordingSeed): boolean {
  return INSTRUMENTAL.test(seed.title);
}

export class CollectorService {
  readonly #fetch: typeof fetch;
  readonly #musicbrainz: MusicBrainzClient;
  readonly #listenbrainz: ListenBrainzClient;
  constructor(readonly config: CollectorConfig) {
    this.#fetch = config.fetch ?? fetch;
    this.#musicbrainz = new MusicBrainzClient(config.userAgent, this.#fetch);
    this.#listenbrainz = new ListenBrainzClient(this.#fetch);
  }

  /** Fills only what MusicBrainz left blank; a Spotify outage costs nothing but the gap. */
  async #enrich(seed: RecordingSeed): Promise<RecordingSeed> {
    if (this.config.spotify === undefined || (seed.isrc !== undefined && seed.duration_ms !== undefined)) return seed;
    const found = await this.config.spotify.identify(seed).catch(() => undefined);
    if (found === undefined) return seed;
    return {
      ...seed,
      ...(seed.isrc === undefined && found.isrc !== undefined ? { isrc: found.isrc } : {}),
      ...(seed.duration_ms === undefined && found.durationMs !== undefined ? { duration_ms: found.durationMs } : {}),
      ...(seed.album === undefined && found.album !== undefined ? { album: found.album } : {}),
    };
  }

  async run(): Promise<CollectionReport> {
    const report: CollectionReport = { discovered: 0, identified: 0, submitted: 0, review: 0, skipped: 0, errors: [] };
    const pools: RecordingSeed[] = [];
    this.config.onProgress?.({ stage: "discovering", markets: this.config.markets });
    for (const market of this.config.markets) {
      const [popular, fresh] = await Promise.all([
        this.#listenbrainz.popular(market, 100).catch(() => []),
        this.#musicbrainz.fresh(market, 14, 100).catch(() => []),
      ]);
      pools.push(...popular, ...fresh);
    }
    const unique = new Map<string, RecordingSeed>();
    for (const seed of pools) {
      const key = `${seed.artist.normalize("NFKC").toLowerCase()}\0${seed.title.normalize("NFKC").toLowerCase()}`;
      const old = unique.get(key);
      if (old === undefined) unique.set(key, seed);
      else
        unique.set(key, {
          ...old,
          popularity: Math.max(old.popularity, seed.popularity),
          freshness: Math.max(old.freshness, seed.freshness),
        });
    }
    const ranked = [...unique.values()]
      .sort((a, b) => b.popularity * 0.65 + b.freshness * 0.35 - (a.popularity * 0.65 + a.freshness * 0.35))
      .slice(0, this.config.dailyBudget);
    report.discovered = ranked.length;
    this.config.onProgress?.({ stage: "selected", total: ranked.length });
    for (const [index, seed] of ranked.entries()) {
      this.config.onProgress?.({ stage: "processing", current: index + 1, total: ranked.length, song: `${seed.artist} - ${seed.title}` });
      const song = `${seed.artist} - ${seed.title}`;
      // Nothing downstream can use a track with no words: the pipeline aligns lyrics to audio,
      // so submitting one only parks a recording in review that no one can ever act on.
      if (hasNoLyricsToAlign(seed)) {
        report.skipped++;
        this.config.onProgress?.({ stage: "skipped", current: index + 1, total: ranked.length, song, reason: "instrumental" });
        continue;
      }
      try {
        const identified = await this.#enrich(await this.#musicbrainz.identify(seed).catch(() => seed));
        if (identified.isrc) report.identified++;
        const sources = await (this.config.youtubeSearch ?? searchYoutubeMusic)(identified);
        const durationMs = resolveDurationMs(identified, sources);
        if (durationMs === undefined) throw new Error("DURATION_UNAVAILABLE");
        const recording = { ...identified, duration_ms: durationMs };
        const lyrics: LyricsProviderResult[] = await this.config.lyricsProvider.search(lyricsSearchInput(identified));
        // Every provider came back empty. Without a single line of text there is nothing to
        // time, and the recording would sit in review blocked on lyrics that do not exist.
        if (lyrics.length === 0) {
          report.skipped++;
          this.config.onProgress?.({ stage: "skipped", current: index + 1, total: ranked.length, song, reason: "no-lyrics" });
          continue;
        }
        const selected = sources[0]?.official === true && sources[0].score >= 0.9;
        const response = await this.#fetch(`${this.config.adminUrl.replace(/\/$/u, "")}/admin/api/collector/recordings`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.config.adminToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            recording,
            sources: sources.map((source, index) => ({ ...source, rank: index + 1, selected: selected && index === 0 })),
            lyrics,
            priority: identified.popularity * 0.65 + identified.freshness * 0.35,
          }),
        });
        if (!response.ok) throw new Error(await adminErrorCode(response));
        const result = (await response.json()) as { job_id?: string | null; deduplicated?: boolean; blocked_by?: string[] };
        if (result.job_id) report.submitted++;
        else report.review++;
        this.config.onProgress?.({
          stage: "delivered",
          current: index + 1,
          total: ranked.length,
          song: `${seed.artist} - ${seed.title}`,
          destination: result.job_id ? "generator" : "review",
          ...(result.job_id ? { jobId: result.job_id } : { reason: reviewReason(result.blocked_by ?? [], sources) }),
          deduplicated: result.deduplicated === true,
        });
      } catch (error) {
        const code = error instanceof Error ? error.message : "UNKNOWN";
        report.errors.push({ song: `${seed.artist} - ${seed.title}`, code });
        this.config.onProgress?.({
          stage: "failed",
          current: index + 1,
          total: ranked.length,
          song: `${seed.artist} - ${seed.title}`,
          code,
        });
      }
    }
    return report;
  }
}

/** Turns the server's list of what is missing into something worth reading in a log. */
export function reviewReason(blockedBy: string[], sources: YoutubeCandidate[]): string {
  const parts: string[] = [];
  if (blockedBy.includes("isrc")) parts.push("ISRC 없음");
  if (blockedBy.includes("source")) {
    const best = sources[0];
    parts.push(
      best === undefined ? "음원 후보 없음" : `자동 선택 기준 미달 (최고 ${best.score.toFixed(2)}${best.official ? ", 공식" : ", 비공식"})`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : "확인 필요";
}

export function lyricsSearchInput(seed: RecordingSeed): Parameters<LyricsProvider["search"]>[0] {
  return {
    ...(seed.isrc ? { isrc: seed.isrc } : {}),
    ...(seed.mbid ? { mbid: seed.mbid } : {}),
    artist: seed.artist,
    title: seed.title,
    ...(seed.album ? { album: seed.album } : {}),
  };
}

export function resolveDurationMs(seed: RecordingSeed, sources: YoutubeCandidate[]): number | undefined {
  if (typeof seed.duration_ms === "number" && Number.isFinite(seed.duration_ms) && seed.duration_ms > 0)
    return Math.round(seed.duration_ms);
  const source = sources.find((item) => Number.isFinite(item.duration_ms) && item.duration_ms > 0);
  return source === undefined ? undefined : Math.round(source.duration_ms);
}

async function adminErrorCode(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
  const detail = typeof payload?.error === "string" && /^[A-Z0-9_]+$/u.test(payload.error) ? `_${payload.error}` : "";
  return `ADMIN_${response.status}${detail}`;
}
