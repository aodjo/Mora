import type { LyricsProvider, LyricsProviderResult } from "../../packages/contracts/src/index.js";
import { chartSeeds } from "./charts.js";
import { MusicBrainzClient } from "./musicbrainz.js";
import type { CollectorConfig, RecordingSeed, YoutubeCandidate } from "./types.js";
import { RECORDING_DRIFT_TOLERANCE_MS, searchYoutubeMusic } from "./youtube.js";

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
  // 카탈로그가 밝힌 것이 먼저다. 제목은 그것을 못 볼 때 남는 단서일 뿐이고, 아무 표시 없이
  // 올라오는 반주는 제목만으로 걸러지지 않는다.
  return seed.instrumental === true || INSTRUMENTAL.test(seed.title);
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

  /** 이미 가진 곡들의 ISRC. 차트가 마르면 이것이 앨범으로 가는 문이 된다. */
  get isrcs(): string[] {
    return [...this.#isrcs];
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
    // LyricFind answers what a catalogue needs to answer — which recording, how long — with no
    // client quota to exhaust. Spotify used to come first and spent more of this run rate-limited
    // than working, so it is gone rather than second.
    let enriched = seed;
    for (const catalogue of [this.config.lyricfind]) {
      if (catalogue === undefined) continue;
      // 예전에는 MusicBrainz 가 ISRC 와 길이를 둘 다 비워 두었을 때만 물었다. MusicBrainz 는
      // 길이를 거의 언제나 채우므로 사실상 한 번도 묻지 않은 셈이고, 그래서 자동 선택이
      // 기대던 catalogue_duration_ms 가 늘 비어 있었다. 게이트가 필요한 것은 아무 길이가
      // 아니라 우리가 공개하는 마스터의 길이이므로, 이제는 언제나 묻는다 — 곡당 요청 하나다.
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
        // 차트가 옮겨 적은 이름 대신 카탈로그가 걸어 둔 이름으로. 가사를 들고 있는 서비스는
        // 「청춘만화」로 걸었지 "Coming Of Age Story" 로 걸지 않았다.
        ...(sameRelease && found.nativeTitle !== undefined ? { title: found.nativeTitle } : {}),
        ...(sameRelease && found.nativeArtist !== undefined ? { artist: found.nativeArtist } : {}),
        // 언어는 재어서 아는 편이 낫다. 가사의 글자를 세어 짐작하면 머리글의 한글 넉 자로
        // 영어 랩이 한국어가 된다.
        ...(enriched.language === undefined && found.language !== undefined ? { language: found.language } : {}),
      };
      if (found.instrumental === true) return { ...enriched, instrumental: true };
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
    const picked = fresh
      .sort((a, b) => b.popularity * 0.65 + b.freshness * 0.35 - (a.popularity * 0.65 + a.freshness * 0.35))
      .slice(0, want);
    // 차트는 며칠이면 마른다. 상위권이 고정되어 있어 같은 목록을 다시 훑을 뿐이고, 실측하면
    // 4,600 번을 "이미 수집함"으로 건너뛰면서 새 곡은 하나도 나오지 않았다.
    //
    // 앨범 확장이 이 자리를 위해 있는 기능인데, 그것은 새로 수집되는 곡에 얹혀 있었다 —
    // 이미 가진 곡은 identify 전에 걸러지므로 release_mbid 를 얻을 기회조차 없고, 새 곡이
    // 없으면 확장도 없다. 닭과 달걀이다. 그래서 카탈로그에서 직접 걷는다.
    if (picked.length < want) picked.push(...(await this.#fromAlbums(collected, want - picked.length)));
    return picked;
  }

  /**
   * 이미 가진 곡들이 실린 앨범의 나머지 트랙.
   *
   * ISRC 로 릴리스를 찾고 그 릴리스의 트랙을 받아 온다. 차트는 앨범의 히트곡 하나만 이름
   * 붙이므로, 그 나머지는 이 길이 아니면 오지 않는다.
   */
  async #fromAlbums(collected: CollectedIndex, want: number): Promise<RecordingSeed[]> {
    if (want <= 0) return [];
    const found: RecordingSeed[] = [];
    const seen = new Set<string>();
    // 최근에 들어온 것부터 — 새로 수집된 곡의 앨범이 아직 안 걸린 것일 가능성이 높다.
    for (const isrc of collected.isrcs.reverse()) {
      if (found.length >= want) break;
      const recording = await this.#musicbrainz
        .identify({ artist: "", title: "", isrc, popularity: 0, freshness: 0, market: "KR" })
        .catch(() => undefined);
      const release = recording?.release_mbid;
      if (release === undefined || seen.has(release)) continue;
      seen.add(release);
      for (const track of await this.#musicbrainz.albumTracks(release).catch(() => [])) {
        if (found.length >= want) break;
        const sibling: RecordingSeed = {
          artist: track.artist,
          title: track.title,
          ...(track.mbid === undefined ? {} : { mbid: track.mbid }),
          // 차트에 오른 곡보다 반 걸음 아래. 차트가 다시 움직이면 그쪽이 먼저 간다.
          popularity: 0.4,
          freshness: 0,
          market: "KR",
        };
        if (collected.hasName(sibling)) continue;
        if (found.some((item) => songKey(item.artist, item.title) === songKey(sibling.artist, sibling.title))) continue;
        found.push(sibling);
      }
    }
    if (found.length > 0)
      this.config.onProgress?.({ stage: "expanded", album: `앨범 ${seen.size}장`, added: found.length, total: found.length });
    return found;
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
        // 카탈로그를 물어본 뒤에야 노래가 없는 트랙인 줄 아는 경우가 있다 — 제목에 아무
        // 표시가 없는 반주가 그렇다. 여기서 다시 본다.
        if (hasNoLyricsToAlign(identified)) {
          report.skipped++;
          collected.remember(identified);
          collected.remember(seed);
          await this.#remember(seed, "instrumental");
          this.config.onProgress?.({ stage: "skipped", current: index + 1, total: queue.length, song, reason: "instrumental" });
          continue;
        }
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
        // The seed's own length, not the resolved one: when nothing knew how long the song was,
        // `durationMs` is the candidate's own length and checking it against itself always agrees.
        const selected = canAutoSelect(sources[0], identified.duration_ms);
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
          ...(result.job_id
            ? { jobId: result.job_id }
            : { reason: reviewReason(result.blocked_by ?? [], sources, identified.duration_ms) }),
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

/**
 * How well the title and the artist have to agree before a length match is allowed to decide.
 *
 * 0.85 was set against weights that no unofficial upload could reach: a flat yt-dlp search
 * returns the whole video title, so titleScore is 0.8 rather than 1 for the large majority of
 * real candidates, and the arithmetic left the artist's own channel as the only way through.
 * At 0.75 an upload still has to name both the song and the artist — a title-only or
 * artist-only match lands at 0.68 or below and stays in review.
 */
const AUTO_SELECT_SCORE = 0.75;

/**
 * Whether a source can go to the Generator without a person looking at it.
 *
 * Requiring the artist's own channel sounded right and is too narrow to use: BTS upload as
 * BANGTANTV and HYBE LABELS, and for "SWIM" those channels hold a 4:05 music video and a 2:52
 * performance cut, while the only copy of the 2:39 recording is a reupload. What decides whether
 * timings will be right is not who posted the file but whether it runs to the length of the
 * master we publish under: the real uploads came in 993ms, 467ms and 920ms out, the music video
 * 86 seconds out. Over 70 songs that aligned cleanly the gap never passed 2.4s.
 *
 * So length is the gate and ownership is a nudge in the score, with one exception that is not a
 * preference but an absence: with no length on the recording at all there is nothing to compare,
 * and then the artist's own channel is the only assurance left. That path is rarer than the
 * previous code implied — it is the fallback, not the rule.
 *
 * The length compared against is the one the recording will be published with, whatever filled
 * it in. `catalogue_drift_ms` is set only when LyricFind answered, which happens only when
 * MusicBrainz left the ISRC or the length blank; for every other song the length is MusicBrainz'
 * and just as much the length we publish. Pass the seed's own length, never the one resolved
 * from the candidate — comparing an upload against itself always agrees.
 */
export function canAutoSelect(best: YoutubeCandidate | undefined, recordingDurationMs?: number): boolean {
  if (best === undefined || best.score < AUTO_SELECT_SCORE) return false;
  const drift = recordingDrift(best, recordingDurationMs);
  if (drift !== undefined) return drift <= RECORDING_DRIFT_TOLERANCE_MS;
  return best.official;
}

/** The candidate's distance from the length we publish, preferring the catalogue's answer. */
function recordingDrift(best: YoutubeCandidate, recordingDurationMs?: number): number | undefined {
  if (best.catalogue_drift_ms !== undefined) return best.catalogue_drift_ms;
  if (recordingDurationMs === undefined || !(best.duration_ms > 0)) return undefined;
  return Math.abs(recordingDurationMs - best.duration_ms);
}

/** Turns the server's list of what is missing into something worth reading in a log. */
export function reviewReason(blockedBy: string[], sources: YoutubeCandidate[], recordingDurationMs?: number): string {
  const parts: string[] = [];
  if (blockedBy.includes("source")) {
    const best = sources[0];
    parts.push(best === undefined ? "음원 후보 없음" : `자동 선택 기준 미달 (${whyNotSelected(best, recordingDurationMs)})`);
  }
  return parts.length > 0 ? parts.join(" · ") : "확인 필요";
}

/** Names the one thing standing between the best candidate and the Generator. */
function whyNotSelected(best: YoutubeCandidate, recordingDurationMs?: number): string {
  if (best.score < AUTO_SELECT_SCORE) return `점수 ${best.score.toFixed(2)}`;
  const drift = recordingDrift(best, recordingDurationMs);
  if (drift === undefined) return "카탈로그 길이 없음, 아티스트 채널 아님";
  return `길이 ${(drift / 1000).toFixed(1)}초 차이`;
}

export function lyricsSearchInput(seed: RecordingSeed): Parameters<LyricsProvider["search"]>[0] {
  return {
    ...(seed.isrc ? { isrc: seed.isrc } : {}),
    ...(seed.mbid ? { mbid: seed.mbid } : {}),
    artist: seed.artist,
    title: searchableTitle(seed.title),
    ...(seed.album ? { album: seed.album } : {}),
  };
}

/**
 * The title as a lyrics search can find it.
 *
 * A credit clause belongs to the release, not to the words: "살인 아니고 사랑인데요??
 * (Feat. $ATSUKI & 백노루양 of 나의 노랑말들)" found nothing on any of five services that all
 * carry the song under the bare title. The clause is dropped from the query only — the song
 * keeps its full name everywhere else.
 */
export function searchableTitle(title: string): string {
  // 크레딧 절은 괄호가 중첩되기도 한다 — "(Prod. PATEKO (파테코))" — 그래서 정규식 대신
  // 여닫음을 세며 걷어낸다. 크레딧 단어로 시작하는 괄호 묶음만 통째로.
  const opens: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  let bare = "";
  let index = 0;
  while (index < title.length) {
    const character = title[index]!;
    const close = opens[character];
    if (close !== undefined && /^\s*(?:featuring|feat|ft|prod|with)\b/iu.test(title.slice(index + 1))) {
      let depth = 1;
      let scan = index + 1;
      while (scan < title.length && depth > 0) {
        if (opens[title[scan]!] !== undefined) depth += 1;
        else if (title[scan] === ")" || title[scan] === "]" || title[scan] === "}") depth -= 1;
        scan += 1;
      }
      index = scan;
      continue;
    }
    bare += character;
    index += 1;
  }
  bare = bare
    // "feat.pshine" 처럼 점 뒤에 붙여 쓰기도 한다 — 공백을 요구하면 놓친다.
    .replace(/\s+(?:featuring|feat|ft)\b\.?\s*\S.*$/iu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  // 제목 전체가 크레딧처럼 생겼다면 지운 쪽이 잘못 본 것이다 — 원제를 그대로 쓴다.
  return bare.length > 0 ? bare : title;
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
