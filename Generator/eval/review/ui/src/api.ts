/**
 * The single place that talks to the server. The view layer never calls fetch directly.
 */

/** Timing of a single character. The alignment model's vocabulary is syllables, so this is the unit it natively emits. */
export interface Grain {
  text: string;
  at: number;
  end: number;
  /** How sure the model is (the margin against the character it would have picked there). 0 means the model heard the same character. */
  sure?: number;
  /** A spot the model was unusually unsure about within this song. A human must look at it. */
  shaky?: boolean;
}

/** A word timing typed in by a human. Words not yet stamped have `at` set to null. */
export interface Word {
  text: string;
  at: number | null;
  end?: number | null;
  /** Per-character timings inside the word. When present, karaoke is painted character by character. */
  chars?: Grain[] | null;
  /** Confidence of the weakest character in the phrase. One character off makes the whole phrase untrustworthy. */
  sure?: number;
  shaky?: boolean;
  /**
   * Which voice sings this word, when it differs from the rest of its line.
   *
   * Present only where the voice changes inside a line — a bracketed run of backing vocals against
   * the lead that follows it. Absent everywhere else, and then the line's own lane holds.
   */
  lane?: number;
  /**
   * Why this **line** fell apart. Attached only to the first word of the line.
   *
   * This is a different measure from confidence (`sure`). Confidence is how sure the model is about a
   * character, and on this model it was weak — it caught only two out of every five bad lines. This one
   * looks at **contradictions inside the alignment result** instead: the same phrase placed with different
   * durations across the song, characters all crammed against the minimum spacing, or several seconds of
   * emptiness inside a line. It uses no externally supplied timings, so it does not wobble when the audio
   * source changes.
   */
  stuck?: string;
}

/** One line of lyrics with its start time and, once aligned, its words. */
export interface Line {
  at: number;
  /**
   * Which voice this is. 0 = main, 1 = sub (backing vocals, ad-libs).
   *
   * When absent, the view guesses from parentheses. Once the vocals have been split into lead and sub,
   * the server decides it by **which stem it matched better against** — parentheses are a habit of whoever
   * transcribed the lyrics, so they cannot be trusted.
   */
  lane?: number;
  /** Where the line ends. Present only in LRCLIB's `lyricsfile`; the LRC format and Vibe do not carry it. */
  end?: number;
  text: string;
  words?: Word[];
}

/** A human's judgement of an aligned song, or null while it has not been judged yet. */
export type Verdict = "good" | "off" | "wrong" | "drop" | null;

/** A song in the review queue, with its lines attached once they have been loaded. */
export interface Song {
  id: number;
  video_id: string;
  artist: string;
  title: string;
  language: string;
  duration: number;
  verdict: Verdict;
  note: string;
  offset_ms: number;
  line_count: number;
  has_audio: boolean;
  lines?: Line[];
}

/** A lyrics search result returned by one of the lyric sources. */
export interface LyricHit {
  artist: string;
  title: string;
  album: string;
  duration: number;
  lines: Line[];
  instrumental: boolean;
}

/** An audio search result returned by the YouTube lookup. */
export interface AudioHit {
  video_id: string;
  title: string;
  uploader: string;
  duration: number;
}

/**
 * Issues one JSON request against the API and returns the decoded body.
 *
 * The Content-Type header is set only when there is a body, so plain GET requests stay preflight-free.
 * On a non-OK response the server's own explanation is surfaced verbatim: showing just "request failed"
 * leaves nothing to debug with. When the error body cannot be parsed as JSON, the HTTP status line is
 * used as the message instead.
 *
 * @async
 * @param {string} path - API path to request.
 * @param {RequestInit} [init] - Extra fetch options, such as method and body.
 * @returns {Promise<T>} The parsed JSON response body.
 * @throws {Error} When the response is not OK, carrying the server's `detail` or the HTTP status line.
 */
async function ask<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.detail ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Lists every song in the review queue.
 *
 * The list form carries no lines; call `getSong` to load them for one song.
 *
 * @returns {Promise<Song[]>} All songs, without their lines.
 */
export const listSongs = () => ask<Song[]>("/api/songs");

/**
 * Loads one song together with its lines.
 *
 * @param {number} id - Song id.
 * @returns {Promise<Song>} The song, with `lines` populated.
 */
export const getSong = (id: number) => ask<Song>(`/api/songs/${id}`);

/**
 * Updates part of a song, such as its verdict, note, or offset.
 *
 * Only the fields present in the patch are touched; the rest keep their stored values.
 *
 * @param {number} id - Song id.
 * @param {Partial<Song>} patch - The fields to change.
 * @returns {Promise<Song>} The song as it stands after the update.
 */
export const editSong = (id: number, patch: Partial<Song>) =>
  ask<Song>(`/api/songs/${id}`, { method: "PATCH", body: JSON.stringify(patch) });

/**
 * Removes a song from the review queue.
 *
 * @param {number} id - Song id.
 * @returns {Promise<{ ok: boolean }>} Whether the deletion went through.
 */
export const dropSong = (id: number) =>
  ask<{ ok: boolean }>(`/api/songs/${id}`, { method: "DELETE" });

/**
 * Adds a new song to the review queue.
 *
 * The lyric lines are handed over at creation time, so the song arrives ready to be aligned.
 *
 * @param {Object} song - The song to create.
 * @param {string} song.video_id - Audio source video id.
 * @param {string} song.artist - Artist name.
 * @param {string} song.title - Song title.
 * @param {number} song.duration - Length in seconds.
 * @param {Line[]} song.lines - Lyric lines to store with the song.
 * @returns {Promise<Song>} The created song.
 */
export const addSong = (song: {
  video_id: string; artist: string; title: string; duration: number; lines: Line[];
}) => ask<Song>("/api/songs", { method: "POST", body: JSON.stringify(song) });

/** Lyrics source. Vibe is better for Korean songs — many LRCLIB sheets are written in romanized script. */
export type LyricSource = "vibe" | "lrclib";

/**
 * Searches a lyric source for candidate sheets.
 *
 * Title only, artist only, or both may be given — the server turns whichever combination arrives into
 * the query that suits it.
 *
 * @param {LyricSource} source - Which lyric source to search.
 * @param {Object} query - Search terms.
 * @param {string} [query.q] - Free-text query.
 * @param {string} [query.artist] - Artist name.
 * @param {string} [query.title] - Song title.
 * @returns {Promise<LyricHit[]>} Matching lyric sheets.
 */
export const findLyrics = (source: LyricSource, query: { q?: string; artist?: string; title?: string }) =>
  ask<LyricHit[]>(`/api/${source}?` + new URLSearchParams(query as Record<string, string>));

/**
 * Searches for audio to pair with a song.
 *
 * @param {string} q - Search query.
 * @param {number} [want=8] - How many results to ask for.
 * @returns {Promise<AudioHit[]>} Matching audio candidates.
 */
export const findAudio = (q: string, want = 8) =>
  ask<AudioHit[]>(`/api/youtube?${new URLSearchParams({ q, want: String(want) })}`);

/**
 * Starts alignment with our model. A human then listens to the result and judges it.
 *
 * When `fresh` is set, **the stems are rebuilt from scratch.** Reusing the cache prints
 * "vocals extracted · 0s", but if a human pressed "align again" they meant "from the beginning,
 * with the code as it stands now".
 *
 * @param {number} id - Song id.
 * @param {boolean} [fresh=false] - Rebuild the stems instead of reusing the cache.
 * @returns {Promise<{ state: string }>} The alignment job state.
 */
export const startAlign = (id: number, fresh = false) =>
  ask<{ state: string }>(`/api/songs/${id}/align${fresh ? "?fresh=1" : ""}`, { method: "POST" });

/** One line of the alignment trail. The server appends one per step — the view shows them like a terminal. */
export interface Beat { at: number; text: string; kind: "step" | "done" | "bad" }

/**
 * Polls the alignment state of a song.
 *
 * The log accumulates across the run, so the view can render the whole trail from any single poll.
 *
 * @param {number} id - Song id.
 * @returns {Promise<{ state: string; log?: Beat[] }>} The current state and the trail so far.
 */
export const alignState = (id: number) =>
  ask<{ state: string; log?: Beat[] }>(`/api/songs/${id}/align`);

/**
 * Starts downloading the audio for a video.
 *
 * @param {string} videoId - Video id to fetch audio for.
 * @returns {Promise<{ state: string }>} The download job state.
 */
export const startFetch = (videoId: string) =>
  ask<{ state: string }>(`/api/audio/${videoId}`, { method: "POST" });

/**
 * Polls the audio download state for a video.
 *
 * @param {string} videoId - Video id being fetched.
 * @returns {Promise<{ state: string }>} The current download state.
 */
export const fetchState = (videoId: string) =>
  ask<{ state: string }>(`/api/audio/${videoId}`);

/**
 * Formats a number of seconds as a clock reading.
 *
 * Non-finite and negative inputs fall back to "0:00" rather than rendering NaN or a negative time,
 * because durations arrive from the server and from media elements that report both. Seconds are
 * floored and zero-padded to two digits; minutes are not padded.
 *
 * @param {number} seconds - Time in seconds.
 * @returns {string} The time as `m:ss`, or "0:00" for non-finite or negative input.
 */
export const clock = (seconds: number) => {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
};
