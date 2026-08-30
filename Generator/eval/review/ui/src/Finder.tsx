/**
 * Where a song gets added. Making one song takes two things — lyrics (LRCLIB) and audio (YouTube).
 *
 * In the combined mode the two are laid side by side and picked one at a time. How far the
 * durations diverge is visible right there, which makes live takes and remakes easy to spot.
 * When only one side is needed (swapping just the audio) the panes open individually.
 */

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioHit, LyricHit, LyricSource } from "./api";
import { clock, findAudio, findLyrics } from "./api";

/** Which panes are open: both sides at once, lyrics only, or audio only. */
export type Mode = "both" | "lyrics" | "audio";

interface Props {
  mode: Mode;
  seedArtist?: string;
  seedTitle?: string;
  /** When swapping only the audio, the duration to compare candidates against. */
  wantSeconds?: number;
  onClose: () => void;
  onPick: (picked: { lyric?: LyricHit; audio?: AudioHit }) => void;
}

/**
 * Modal sheet for finding a lyric sheet and an audio track and picking one of each.
 *
 * The artist and title fields drive both searches through a single query debounced by 420 ms,
 * so typing does not fire a request per keystroke; changing the mode or the lyric source
 * re-runs it the same way. Escape closes the sheet, and so does a click that lands on the
 * backdrop itself rather than bubbling up out of the sheet.
 *
 * Every candidate row carries its duration, and audio rows also carry the gap against the
 * reference duration: 3 seconds or less reads as a match, 8 seconds or less is neutral, and
 * anything wider is flagged. That gap is the whole point of showing the two lists together —
 * it is what makes live takes and remakes stand out before they are ever picked.
 *
 * The confirm button stays disabled until the current mode has everything it needs: audio
 * only wants an audio hit, lyrics only wants a lyric hit, and the combined mode wants both.
 *
 * @param {Props} props - Component props.
 * @param {Mode} props.mode - Mode the sheet opens in; the user can switch it afterwards.
 * @param {string} [props.seedArtist] - Artist to prefill the search with.
 * @param {string} [props.seedTitle] - Title to prefill the search with.
 * @param {number} [props.wantSeconds] - Reference duration used when only the audio is being swapped.
 * @param {() => void} props.onClose - Called when the sheet should be dismissed.
 * @param {(picked: { lyric?: LyricHit, audio?: AudioHit }) => void} props.onPick - Called with the chosen hits on confirm.
 * @returns {React.ReactElement} The finder sheet.
 */
export function Finder({ mode: initial, seedArtist, seedTitle, wantSeconds, onClose, onPick }: Props) {
  const [mode, setMode] = useState<Mode>(initial);
  /** Lyric source, defaulting to Vibe: Korean songs go there first, because out of forty songs only five of the LRCLIB sheets were usable. */
  const [source, setSource] = useState<LyricSource>("vibe");
  const [artist, setArtist] = useState(seedArtist ?? "");
  const [title, setTitle] = useState(seedTitle ?? "");
  const [lyrics, setLyrics] = useState<LyricHit[] | null>(null);
  const [audios, setAudios] = useState<AudioHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pickedLyric, setPickedLyric] = useState<number | null>(null);
  const [pickedAudio, setPickedAudio] = useState<number | null>(null);
  const timer = useRef<number | undefined>(undefined);

  /**
   * Run the lyric and audio searches for the current fields.
   *
   * Both requests are fired together, since there is no reason for one to wait on the other
   * just because it is slow. `Promise.allSettled` keeps a failure on one side from throwing
   * away the results of the other: whichever side settled gets its list, the failed side
   * falls back to an empty list, and the first rejection's message is surfaced as the error.
   * The mode short-circuits the side it does not need with an already-resolved empty array
   * rather than skipping the call site. Empty fields clear both lists back to the
   * not-yet-searched state instead of issuing a blank query.
   *
   * @async
   * @returns {Promise<void>} Resolves once both searches have settled and state is updated.
   */
  const run = useCallback(async () => {
    const free = [artist, title].filter(Boolean).join(" ").trim();
    if (!free) { setLyrics(null); setAudios(null); return; }
    setBusy(true); setError("");
    try {
      const [got1, got2] = await Promise.allSettled([
        mode === "audio" ? Promise.resolve([]) : findLyrics(source, { artist, title }),
        mode === "lyrics" ? Promise.resolve([]) : findAudio(free),
      ]);
      setLyrics(got1.status === "fulfilled" ? (got1.value as LyricHit[]) : []);
      setAudios(got2.status === "fulfilled" ? (got2.value as AudioHit[]) : []);
      const failed = [got1, got2].find((g) => g.status === "rejected");
      if (failed && failed.status === "rejected") setError(String(failed.reason?.message ?? failed.reason));
    } finally {
      setBusy(false);
    }
  }, [artist, title, mode, source]);

  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(run, 420);
    return () => window.clearTimeout(timer.current);
  }, [run]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const lyric = pickedLyric === null ? undefined : lyrics?.[pickedLyric];
  const audio = pickedAudio === null ? undefined : audios?.[pickedAudio];
  /** Duration every candidate is measured against: the original song's length when only the audio is being swapped, otherwise the length of the chosen lyric sheet. */
  const reference = wantSeconds ?? lyric?.duration;
  const ready = mode === "audio" ? !!audio : mode === "lyrics" ? !!lyric : !!lyric && !!audio;

  return (
    <motion.div
      className="veil" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.22 }}
    >
      <motion.div
        className="sheet"
        initial={{ y: 18, scale: 0.985, opacity: 0 }}
        animate={{ y: 0, scale: 1, opacity: 1 }}
        exit={{ y: 10, scale: 0.99, opacity: 0 }}
        transition={{ type: "spring", stiffness: 320, damping: 30, mass: 0.8 }}
      >
        <div className="sheet-head">
          <h2>곡 넣기</h2>
          <div className="modes">
            {([["both", "통합"], ["lyrics", "가사만"], ["audio", "음원만"]] as const).map(([key, label]) => (
              <button key={key} className={`mode ${mode === key ? "on" : ""}`} onClick={() => setMode(key)}>
                {label}
              </button>
            ))}
          </div>
          <div className="fields">
            <input placeholder="아티스트" value={artist} onChange={(event) => setArtist(event.target.value)} autoFocus />
            <input placeholder="제목" value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>
        </div>

        <div className={`panes ${mode === "both" ? "" : "one"}`}>
          {mode !== "audio" && (
            <div className="pane">
              <div className="pane-top pane-top-row">
                <span>가사</span>
                <span className="src">
                  {([["vibe", "바이브"], ["lrclib", "LRCLIB"]] as const).map(([key, label]) => (
                    <button key={key} className={`src-one ${source === key ? "on" : ""}`}
                      onClick={() => setSource(key)}>{label}</button>
                  ))}
                </span>
              </div>
              <div className="pane-list">
                <Hits
                  busy={busy} rows={lyrics}
                  render={(hit: LyricHit, index) => {
                    const gap = reference ? Math.abs(hit.duration - reference) : null;
                    return (
                      <Hit
                        key={index} on={pickedLyric === index} onClick={() => setPickedLyric(index)}
                        name={hit.title}
                        sub={[hit.artist, hit.album].filter(Boolean).join(" · ")}
                        right={<>
                          {hit.lines.length}줄<br />{clock(hit.duration)}
                          {hit.instrumental && <><br /><span className="hit-tag warn">반주</span></>}
                        </>}
                        note={gap !== null && mode === "both" && pickedAudio !== null
                          ? `${gap.toFixed(0)}초 차이` : undefined}
                      />
                    );
                  }}
                />
              </div>
            </div>
          )}

          {mode !== "lyrics" && (
            <div className="pane">
              <div className="pane-top">음원 · 유튜브</div>
              <div className="pane-list">
                <Hits
                  busy={busy} rows={audios}
                  render={(hit: AudioHit, index) => {
                    const gap = reference ? Math.abs(hit.duration - reference) : null;
                    return (
                      <Hit
                        key={index} on={pickedAudio === index} onClick={() => setPickedAudio(index)}
                        name={hit.title} sub={hit.uploader}
                        right={<>
                          {clock(hit.duration)}
                          {gap !== null && <><br />
                            <span className={`hit-tag ${gap <= 3 ? "good" : gap <= 8 ? "" : "warn"}`}>
                              {gap.toFixed(0)}초
                            </span></>}
                        </>}
                      />
                    );
                  }}
                />
              </div>
            </div>
          )}
        </div>

        <div className="sheet-foot">
          <div className="picked">
            {error && <span className="picked-bad">못 찾음: {error}</span>}
            {!error && mode !== "audio" && (
              <span className={`picked-one ${lyric ? "set" : ""}`}>
                <span className="picked-tag">가사</span>
                {lyric ? `${lyric.artist} — ${lyric.title} · ${lyric.lines.length}줄` : "고르지 않음"}
              </span>
            )}
            {!error && mode !== "lyrics" && (
              <span className={`picked-one ${audio ? "set" : ""}`}>
                <span className="picked-tag">음원</span>
                {audio
                  ? `${audio.title.slice(0, 40)} · ${clock(audio.duration)}` +
                    (reference ? ` · ${Math.abs(audio.duration - reference).toFixed(0)}초 차이` : "")
                  : "고르지 않음"}
              </span>
            )}
          </div>
          <button className="go" disabled={!ready} onClick={() => onPick({ lyric, audio })}>
            {mode === "audio" ? "바꾸기" : "넣기"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/**
 * One result pane: either the rows, or the empty state that explains why there are none.
 *
 * `null` rows and an empty array mean different things and read differently — `null` is
 * "nothing has been searched for yet", an empty array is "searched, found nothing". The
 * spinner only replaces the list while there is nothing to show at all, so a re-search keeps
 * the previous rows on screen instead of flashing the pane empty between keystrokes.
 *
 * @template T
 * @param {object} props - Component props.
 * @param {boolean} props.busy - Whether a search is currently in flight.
 * @param {T[] | null} props.rows - Result rows, or null when no search has run yet.
 * @param {(row: T, index: number) => React.ReactNode} props.render - Renders one row.
 * @returns {React.ReactElement} The rows or an empty-state placeholder.
 */
function Hits<T>({ busy, rows, render }: {
  busy: boolean; rows: T[] | null; render: (row: T, index: number) => React.ReactNode;
}) {
  if (busy && !rows) return <div className="pane-empty"><span className="spin" /> 찾는 중</div>;
  if (!rows) return <div className="pane-empty">검색어를 넣으세요</div>;
  if (!rows.length) return <div className="pane-empty">없음</div>;
  return <AnimatePresence initial={false}>{rows.map(render)}</AnimatePresence>;
}

/**
 * One selectable candidate row.
 *
 * The check mark is always mounted and only animates its scale and opacity, so selection
 * moves between rows without the list reflowing underneath the pointer.
 *
 * @param {object} props - Component props.
 * @param {boolean} props.on - Whether this row is the current selection.
 * @param {() => void} props.onClick - Called when the row is chosen.
 * @param {string} props.name - Primary label, usually the track title.
 * @param {string} props.sub - Secondary label, such as artist, album, or uploader.
 * @param {React.ReactNode} props.right - Right-hand column: duration, line count, and tags.
 * @param {string} [props.note] - Extra detail appended to the secondary label.
 * @returns {React.ReactElement} The row button.
 */
function Hit({ on, onClick, name, sub, right, note }: {
  on: boolean; onClick: () => void; name: string; sub: string;
  right: React.ReactNode; note?: string;
}) {
  return (
    <motion.button
      className={`hit ${on ? "on" : ""}`} onClick={onClick}
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      whileHover={{ backgroundColor: "rgba(255,255,255,0.06)" }}
    >
      <motion.span className="hit-check" animate={{ scale: on ? 1 : 0.4, opacity: on ? 1 : 0 }}
        transition={{ type: "spring", stiffness: 520, damping: 26 }}>✓</motion.span>
      <div className="hit-main">
        <div className="hit-name">{name}</div>
        <div className="hit-sub">{sub}{note ? ` · ${note}` : ""}</div>
      </div>
      <div className="hit-right">{right}</div>
    </motion.button>
  );
}
