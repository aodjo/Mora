import type { LyricsProvider, LyricsProviderResult } from "../../packages/contracts/src/index.js";
import { chartSeeds } from "./charts.js";
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

/** The key the run already uses to fold duplicate chart entries together. */
export function songKey(artist: string, title: string): string {
  return `${artist.normalize("NFKC").toLowerCase()}\0${title.normalize("NFKC").toLowerCase()}`;
}

/**
 * What the catalogue already holds, looked up by name or by ISRC. Charts repeat almost entirely
 * between runs, so without this every run pays for a YouTube search, five lyrics providers and a
 * Spotify lookup per song only to have the server file the result beside an identical one.
 */
export class CollectedIndex {
  readonly #keys = new Set<string>();
  readonly #isrcs = new Set<string>();

  constructor(
    recordings: ReadonlyArray<{ artist: string; title: string; isrc?: string | undefined }>,
    skipped: ReadonlyArray<{ artist: string; title: string }> = [],
  ) {
    for (const recording of recordings) {
      this.#keys.add(songKey(recording.artist, recording.title));
      if (recording.isrc !== undefined && recording.isrc.length > 0) this.#isrcs.add(recording.isrc.toUpperCase());
    }
    // A song we decided not to collect is as settled as one we did; it just left no recording.
    for (const song of skipped) this.#keys.add(songKey(song.artist, song.title));
  }

  get size(): number {
    return this.#keys.size;
  }

  /** Before anything is spent: the chart gave us a name we have already collected under. */
  hasName(seed: RecordingSeed): boolean {
    return this.#keys.has(songKey(seed.artist, seed.title));
  }

  /** After identification: the same recording reached us under a different name. */
  hasIsrc(seed: RecordingSeed): boolean {
    return seed.isrc !== undefined && this.#isrcs.has(seed.isrc.toUpperCase());
  }

  /** Keeps a run from collecting the same song twice when the charts spell it two ways. */
  remember(seed: RecordingSeed): void {
    this.#keys.add(songKey(seed.artist, seed.title));
    if (seed.isrc !== undefined && seed.isrc.length > 0) this.#isrcs.add(seed.isrc.toUpperCase());
  }
}

export class CollectorService {
  readonly #fetch: typeof fetch;
  readonly #musicbrainz: MusicBrainzClient;

  constructor(readonly config: CollectorConfig) {
    this.#fetch = config.fetch ?? fetch;
    this.#musicbrainz = new MusicBrainzClient(config.userAgent, this.#fetch);
  }

  /**
   * Fills what MusicBrainz left blank, and takes over the length when both describe the same
   * release. MusicBrainz carries whichever cut a contributor happened to submit — it put IU's
   * "Love wins all" at 4:05 against a recording that runs 4:31 — and a length that wrong drags
   * every real candidate below auto-selection. A Spotify outage costs nothing but the gap.
   */
  async #enrich(seed: RecordingSeed): Promise<RecordingSeed> {
    // Spotify first for its exact lengths, then LyricFind for what Spotify missed — or for
    // everything, the day Spotify rate-limits the whole run.
    let enriched = seed;
    for (const catalogue of [this.config.spotify, this.config.lyricfind]) {
      if (catalogue === undefined) continue;
      if (enriched.isrc !== undefined && enriched.duration_ms !== undefined) break;
      const found = await catalogue.identify(enriched).catch(() => undefined);
      if (found === undefined) continue;
      // Different ISRCs mean different releases, so the catalogue's length describes another
      // cut and is no longer evidence about ours.
      const sameRelease = enriched.isrc === undefined || found.isrc === undefined || enriched.isrc === found.isrc;
      const length = sameRelease ? found.durationMs : undefined;
      enriched = {
        ...enriched,
        ...(enriched.isrc === undefined && found.isrc !== undefined ? { isrc: found.isrc } : {}),
        ...(length === undefined || enriched.catalogue_duration_ms !== undefined
          ? {}
          : { duration_ms: length, catalogue_duration_ms: length }),
        ...(enriched.album === undefined && found.album !== undefined ? { album: found.album } : {}),
      };
    }
    return enriched;
  }

  /** An outage here costs a wasted run, not a wrong one, so it degrades to collecting everything. */
  async #collected(): Promise<CollectedIndex> {
    try {
      const response = await this.#fetch(`${this.config.adminUrl.replace(/\/$/u, "")}/admin/api/collector/collected`, {
        headers: { authorization: `Bearer ${this.config.adminToken}` },
      });
      if (!response.ok) throw new Error(await adminErrorCode(response));
      const payload = (await response.json()) as {
        recordings?: Array<{ artist?: string; title?: string; isrc?: string }>;
        skipped?: Array<{ artist?: string; title?: string }>;
      };
      const named = <T extends { artist?: string; title?: string }>(rows: T[] | undefined): Array<T & { artist: string; title: string }> =>
        (rows ?? []).flatMap((item) =>
          typeof item.artist === "string" && typeof item.title === "string" ? [item as T & { artist: string; title: string }] : [],
        );
      return new CollectedIndex(named(payload.recordings), named(payload.skipped));
    } catch {
      return new CollectedIndex([]);
    }
  }

  /**
   * The day's shortlist: every market's charts folded together, everything already collected
   * dropped, and only then cut to the budget.
   *
   * The order matters. Cutting first and skipping afterwards spends the whole budget on songs
   * the catalogue already has, so a second run works through 300 skips and collects nothing —
   * the charts hardly move between days. Dropping them before the cut lets each run take the
   * next 300 it does not have, so repeated runs walk down the chart instead of standing still.
   */
  async discover(collected: CollectedIndex = new CollectedIndex([]), want = this.config.dailyBudget): Promise<RecordingSeed[]> {
    const pools: RecordingSeed[] = [];
    this.config.onProgress?.({ stage: "discovering", markets: this.config.markets });
    const source = this.config.chartSource ?? ((market) => chartSeeds(market, this.#fetch));
    for (const market of this.config.markets) pools.push(...(await source(market).catch(() => [])));
    const unique = new Map<string, RecordingSeed>();
    for (const seed of pools) {
      const key = songKey(seed.artist, seed.title);
      const old = unique.get(key);
      if (old === undefined) unique.set(key, seed);
      else
        unique.set(key, {
          ...old,
          popularity: Math.max(old.popularity, seed.popularity),
          freshness: Math.max(old.freshness, seed.freshness),
        });
    }
    const fresh = [...unique.values()].filter((seed) => !collected.hasName(seed));
    this.config.onProgress?.({ stage: "discovered", total: unique.size, alreadyCollected: unique.size - fresh.length });
    return fresh.sort((a, b) => b.popularity * 0.65 + b.freshness * 0.35 - (a.popularity * 0.65 + a.freshness * 0.35)).slice(0, want);
  }

  /** Remembered so the next run does not pay to reach the same answer. */
  async #remember(seed: RecordingSeed, reason: "instrumental" | "no-lyrics" | "no-source"): Promise<void> {
    await this.#fetch(`${this.config.adminUrl.replace(/\/$/u, "")}/admin/api/collector/skipped`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ artist: seed.artist, title: seed.title, reason }),
    }).catch(() => undefined);
  }

  async run(): Promise<CollectionReport> {
    const collected = await this.#collected();
    return this.collect(await this.discover(collected), collected);
  }

  async collect(ranked: RecordingSeed[], known?: CollectedIndex): Promise<CollectionReport> {
    const report: CollectionReport = { discovered: 0, identified: 0, submitted: 0, review: 0, skipped: 0, errors: [] };
    const collected = known ?? (await this.#collected());
    report.discovered = ranked.length;
    this.config.onProgress?.({ stage: "selected", total: ranked.length });
    const queue = [...ranked];
    // Album expansion fills whatever the charts left of the budget. Day one the charts take
    // all of it; once the catalogue holds them, runs spend the rest walking albums.
    const expandedReleases = new Set<string>();
    let expansionCapacity = Math.max(0, this.config.dailyBudget - queue.length);
    for (let index = 0; index < queue.length; index++) {
      const seed = queue[index]!;
      this.config.onProgress?.({ stage: "processing", current: index + 1, total: queue.length, song: `${seed.artist} - ${seed.title}` });
      const song = `${seed.artist} - ${seed.title}`;
      // Already in the catalogue. Checked before anything is spent, because this is most of a
      // second run: the charts barely move between days.
      if (collected.hasName(seed)) {
        report.skipped++;
        this.config.onProgress?.({ stage: "skipped", current: index + 1, total: queue.length, song, reason: "collected" });
        continue;
      }
      // Nothing downstream can use a track with no words: the pipeline aligns lyrics to audio,
      // so submitting one only parks a recording in review that no one can ever act on.
      if (hasNoLyricsToAlign(seed)) {
        report.skipped++;
        collected.remember(seed);
        await this.#remember(seed, "instrumental");
        this.config.onProgress?.({ stage: "skipped", current: index + 1, total: queue.length, song, reason: "instrumental" });
        continue;
      }
      try {
        const identified = await this.#enrich(await this.#musicbrainz.identify(seed).catch(() => seed));
        if (identified.isrc) report.identified++;
        // The charts name the same recording several ways — "IU" and "아이유", a single and its
        // album cut. Identification is what settles that, so the second look happens here, still
        // ahead of the YouTube search and the lyrics providers.
        if (collected.hasIsrc(identified)) {
          report.skipped++;
          this.config.onProgress?.({ stage: "skipped", current: index + 1, total: queue.length, song, reason: "collected" });
          continue;
        }
        const sources = await (this.config.youtubeSearch ?? searchYoutubeMusic)(identified);
        const durationMs = resolveDurationMs(identified, sources);
        // No catalogue length and no playable upload: there is nothing to time against. A song
        // this obscure may surface later, so it is a remembered skip, not a failure to retry
        // every run.
        if (durationMs === undefined) {
          report.skipped++;
          collected.remember(identified);
          collected.remember(seed);
          await this.#remember(seed, "no-source");
          this.config.onProgress?.({ stage: "skipped", current: index + 1, total: queue.length, song, reason: "no-source" });
          continue;
        }
        const recording = { ...identified, duration_ms: durationMs };
        const lyrics: LyricsProviderResult[] = await this.config.lyricsProvider.search(lyricsSearchInput(identified));
        // Every provider came back empty. Without a single line of text there is nothing to
        // time, and the recording would sit in review blocked on lyrics that do not exist.
        if (lyrics.length === 0) {
          report.skipped++;
          collected.remember(identified);
          collected.remember(seed);
          await this.#remember(seed, "no-lyrics");
          this.config.onProgress?.({ stage: "skipped", current: index + 1, total: queue.length, song, reason: "no-lyrics" });
          continue;
        }
        const selected = canAutoSelect(sources[0]);
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
        // Under both names now, so a chart that lists this song twice cannot pay for it twice.
        collected.remember(identified);
        collected.remember(seed);
        if (result.job_id) report.submitted++;
        else report.review++;
        // A chart names an album's one hit; the rest of that album is what listeners search
        // for next, and no chart will ever surface it.
        if (expansionCapacity > 0 && identified.release_mbid !== undefined && !expandedReleases.has(identified.release_mbid)) {
          expandedReleases.add(identified.release_mbid);
          const siblings = await this.#musicbrainz.albumTracks(identified.release_mbid).catch(() => []);
          let added = 0;
          for (const track of siblings) {
            if (expansionCapacity === 0) break;
            const sibling: RecordingSeed = {
              artist: track.artist,
              title: track.title,
              ...(track.mbid === undefined ? {} : { mbid: track.mbid }),
              // Half a step below the hit that named it, so chart songs keep their place in line.
              popularity: seed.popularity * 0.8,
              freshness: seed.freshness,
              market: seed.market,
            };
            if (collected.hasName(sibling)) continue;
            if (queue.some((queued) => songKey(queued.artist, queued.title) === songKey(sibling.artist, sibling.title))) continue;
            queue.push(sibling);
            expansionCapacity--;
            added++;
          }
          if (added > 0) this.config.onProgress?.({ stage: "expanded", album: identified.album ?? seed.title, added, total: queue.length });
        }
        this.config.onProgress?.({
          stage: "delivered",
          current: index + 1,
          total: queue.length,
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
          total: queue.length,
          song: `${seed.artist} - ${seed.title}`,
          code,
        });
      }
    }
    return report;
  }
}

/** Rounding alone puts a match half a second out: YouTube reports whole seconds, catalogues do not. */
const CATALOGUE_DRIFT_TOLERANCE_MS = 2_000;

/**
 * Whether a source can go to the Generator without a person looking at it.
 *
 * Requiring the artist's own channel sounded right and is too narrow to use: BTS upload as
 * BANGTANTV and HYBE LABELS, and for "SWIM" those channels hold a 4:05 music video and a 2:52
 * performance cut, while the only copy of the 2:39 recording is a reupload. What decides whether
 * timings will be right is not who posted the file but whether it runs to the length of the
 * master we publish under, and Spotify answers that against the ISRC itself: the real uploads
 * came in 993ms, 467ms and 920ms out, the music video 86 seconds out. So the catalogue length is
 * the gate, and the artist's channel is one way to clear it rather than the only one.
 */
export function canAutoSelect(best: YoutubeCandidate | undefined): boolean {
  if (best === undefined || best.score < 0.85) return false;
  if (best.catalogue_drift_ms !== undefined) return best.catalogue_drift_ms <= CATALOGUE_DRIFT_TOLERANCE_MS;
  // Nothing authoritative to measure against, so ownership is the only assurance left.
  return best.official;
}

/** Turns the server's list of what is missing into something worth reading in a log. */
export function reviewReason(blockedBy: string[], sources: YoutubeCandidate[]): string {
  const parts: string[] = [];
  if (blockedBy.includes("source")) {
    const best = sources[0];
    parts.push(best === undefined ? "음원 후보 없음" : `자동 선택 기준 미달 (${whyNotSelected(best)})`);
  }
  return parts.length > 0 ? parts.join(" · ") : "확인 필요";
}

/** Names the one thing standing between the best candidate and the Generator. */
function whyNotSelected(best: YoutubeCandidate): string {
  if (best.score < 0.85) return `점수 ${best.score.toFixed(2)}`;
  if (best.catalogue_drift_ms === undefined) return "카탈로그 길이 없음, 아티스트 채널 아님";
  return `길이 ${(best.catalogue_drift_ms / 1000).toFixed(1)}초 차이`;
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
