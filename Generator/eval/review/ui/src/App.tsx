import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AudioHit, Beat, Line, LyricHit, Song, Verdict } from "./api";
import { addSong, alignState, clock, editSong, fetchState, getSong, listSongs, startAlign, startFetch } from "./api";
import { Console } from "./Console";
import { Finder, type Mode } from "./Finder";
import { Lyrics } from "./Lyrics";
import { Timeline } from "./Timeline";
import { Workspace } from "./Workspace";

type Tab = "listen" | "tap" | "shop";

/** How long an unaligned last line is assumed to run, in milliseconds. */
const FALLBACK_SPAN = 4000;

/** A toast that shows briefly in the bottom right corner. `bad` is red, `work` means a job finished and is green. */
interface Note { id: number; text: string; kind: "info" | "work" | "bad" }

/**
 * The review console for machine-aligned lyrics.
 *
 * Owns the whole review session: the song list, the song under review, the audio element
 * and its playback clock, alignment progress, and the toast stack. The one thing a person
 * does here is pass a verdict — aligning is the model's work — so the verdict sits up front
 * and everything else folds away.
 *
 * @returns {JSX.Element} The full application view.
 */
export default function App() {
  const [songs, setSongs] = useState<Song[]>([]);
  const [song, setSong] = useState<Song | null>(null);
  const [needle, setNeedle] = useState("");
  const [finder, setFinder] = useState<Mode | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const noteId = useRef(0);
  const [tab, setTab] = useState<Tab>("listen");
  /**
   * The stem now sounding. `origin` is the untouched track.
   *
   * Switching stems **keeps the listening position** — the original and a stem have to be
   * heard from the same point for the ear to tell what changed. Lose the position and there
   * is nothing left to compare.
   */
  const [stem, setStem] = useState("origin");
  const [nowMs, setNowMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState("");
  /** Progress of an alignment run with our model. With vocal extraction it takes about a minute. */
  const [aligning, setAligning] = useState("");
  /** The trace left by an alignment run. Stacked up and shown like a terminal. */
  const [log, setLog] = useState<Beat[]>([]);
  const [showLog, setShowLog] = useState(false);
  /** The rarely used actions, folded away. */
  const [menu, setMenu] = useState(false);
  /**
   * Closes the overflow menu on any press outside it.
   *
   * Closing only when the mouse leaves the menu made it impossible to close with a finger
   * or with a keyboard, so a window-wide pointer press shuts it instead.
   */
  useEffect(() => {
    if (!menu) return;
    const shut = () => setMenu(false);
    window.addEventListener("pointerdown", shut);
    return () => window.removeEventListener("pointerdown", shut);
  }, [menu]);
  /** Playback rate. Stamping words needs it slowed down for the hand to keep up. */
  const [rate, setRate] = useState(1);
  /** The song whose audio is being fetched. It takes about twenty seconds, so what is being waited on must stay visible throughout. */
  const [pulling, setPulling] = useState<{ title: string; since: number } | null>(null);
  const [waited, setWaited] = useState(0);
  const audio = useRef<HTMLAudioElement>(null);
  /**
   * The playback rate, mirrored into a ref.
   *
   * Switching stems makes the player reset the rate to 1, and capturing `rate` in the
   * restore closure would carry a stale value.
   */
  const rateRef = useRef(1);
  useEffect(() => { rateRef.current = rate; }, [rate]);

  /**
   * Switches the sounding stem, **carrying the listening position and the rate across**.
   *
   * Holding the position is the whole point — the original and a stem have to be heard from
   * the same point for the ear to tell what changed. Rewinding to the start leaves nothing
   * to compare. Attaching a new source resets both the position and the rate, so they are
   * restored once metadata has loaded and seeking is possible again.
   *
   * @param {string} key - Identifier of the stem to play, or `origin` for the untouched track.
   * @param {string} url - Audio URL of that stem.
   * @returns {void}
   */
  const swapStem = useCallback((key: string, url: string) => {
    const element = audio.current;
    if (!element) return;
    const at = element.currentTime;
    const wasPlaying = !element.paused;
    setStem(key);
    element.src = url;
    element.addEventListener("loadedmetadata", () => {
      element.currentTime = at;
      element.playbackRate = rateRef.current;
      if (wasPlaying) void element.play();
    }, { once: true });
  }, []);

  /**
   * Counts the seconds elapsed while audio is being fetched.
   *
   * This is what tells a stall apart from something merely slow.
   */
  useEffect(() => {
    if (!pulling) { setWaited(0); return; }
    const tick = window.setInterval(
      () => setWaited(Math.round((Date.now() - pulling.since) / 1000)), 500);
    return () => window.clearInterval(tick);
  }, [pulling]);

  /**
   * Pushes a toast onto the stack in the bottom right corner.
   *
   * A single line at the bottom centre left no record of what had been pressed — even
   * something that redraws the whole screen, like "realign everything", was one toast
   * flitting past and gone. Stacking them in the same corner as the audio-fetch banner makes
   * it possible to look back at what just happened. At most four are kept, and each clears
   * itself after 3.2 seconds.
   *
   * @param {string} text - Message to show.
   * @param {Note["kind"]} [kind="info"] - Tone of the toast: `bad` is red, `work` is green.
   * @returns {void}
   */
  const say = useCallback((text: string, kind: Note["kind"] = "info") => {
    const id = ++noteId.current;
    setNotes((now) => [...now.slice(-3), { id, text, kind }]);
    window.setTimeout(() => setNotes((now) => now.filter((one) => one.id !== id)), 3200);
  }, []);

  /**
   * Reloads the song list from the server.
   *
   * @async
   * @returns {Promise<void>} Resolves once the list state has been replaced.
   */
  const refresh = useCallback(async () => setSongs(await listSongs()), []);
  useEffect(() => { refresh(); }, [refresh]);

  /**
   * Opens a song and makes it the one under review.
   *
   * Resets the clock, the play state and the stem back to the original, then points the
   * audio element at the song. If its audio has not been downloaded yet, the fetch is started
   * and polled every 2 seconds until it is done or fails; the source is then re-attached with
   * a cache-busting timestamp so the browser does not keep serving the earlier miss.
   *
   * @async
   * @param {number} id - Database id of the song to open.
   * @returns {Promise<void>} Resolves once the song is loaded and any fetch has been started.
   */
  const open = useCallback(async (id: number) => {
    const got = await getSong(id);
    setSong(got); setNowMs(0); setPlaying(false);
    const element = audio.current;
    setStem("origin");
    if (element) { element.pause(); element.src = `/audio/${got.video_id}`; }
    if (got.has_audio) { setState(""); setPulling(null); return; }
    setState("");
    setPulling({ title: `${got.artist} — ${got.title}`, since: Date.now() });
    await startFetch(got.video_id);
    const tick = window.setInterval(async () => {
      const beat = await fetchState(got.video_id);
      if (beat.state === "done") {
        window.clearInterval(tick); setPulling(null);
        if (audio.current) audio.current.src = `/audio/${got.video_id}?t=${Date.now()}`;
        say("음원 준비됨", "work");
      } else if (beat.state.startsWith("실패")) {
        window.clearInterval(tick); setPulling(null); setState(beat.state);
        say(beat.state, "bad");
      }
    }, 2000);
  }, [say]);

  /**
   * Plays or pauses the audio.
   *
   * @returns {void}
   */
  const toggle = useCallback(() => {
    const element = audio.current;
    if (!element) return;
    if (element.paused) { element.play(); setPlaying(true); } else { element.pause(); setPlaying(false); }
  }, []);

  /**
   * Moves playback to a point in the track.
   *
   * @param {number} ms - Target position in milliseconds; anything negative clamps to the start.
   * @returns {void}
   */
  const seek = useCallback((ms: number) => {
    if (audio.current) audio.current.currentTime = Math.max(0, ms) / 1000;
  }, []);

  /**
   * Reads the playback clock every frame while playing.
   *
   * `onTimeUpdate` only arrives about four times a second. Lines change every few seconds, so
   * that was enough for them, but a character lasts 0.4 s and gets **skipped entirely** —
   * that was why karaoke never lit up.
   */
  useEffect(() => {
    if (!playing) return;
    let alive = true;
    const beat = () => {
      if (!alive) return;
      if (audio.current) setNowMs(audio.current.currentTime * 1000);
      requestAnimationFrame(beat);
    };
    const id = requestAnimationFrame(beat);
    return () => { alive = false; cancelAnimationFrame(id); };
  }, [playing]);

  /**
   * Binds play/pause and five-second skips to the keyboard on every screen.
   *
   * Typing into an input or a textarea is left alone. These keys once lived on the tapping
   * screen only, which meant space scrolled the page while listening.
   */
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      if (event.key === " ") { event.preventDefault(); toggle(); }
      else if (event.key === "ArrowLeft") {
        event.preventDefault(); seek(Math.max(0, (audio.current?.currentTime ?? 0) * 1000 - 5000));
      } else if (event.key === "ArrowRight") {
        event.preventDefault(); seek((audio.current?.currentTime ?? 0) * 1000 + 5000);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [toggle, seek]);

  const offset = song?.offset_ms ?? 0;
  const lines = song?.lines ?? [];
  /**
   * When a line **actually begins**. Follows the first aligned character when there is one,
   * and otherwise the line time that came from outside.
   *
   * There must not be two clocks. Which line to light was being decided from the line times
   * Vibe supplied, while the characters were painted from the character times we aligned
   * ourselves. The two drift by a median of 76 ms, p90 1051 ms, and up to 1.4 s — while a
   * line is still grey its first characters are already past due, and the instant the line
   * lights they **all snap to white at once**. Drifting the other way, the singing has
   * already started while the line stays grey.
   *
   * What the view shows is **the result we aligned**, so lighting a line has to follow that
   * too. Only the timestamp printed beside a line is left as Vibe gave it — that is a
   * yardstick to compare against, not one to draw with.
   *
   * @param {Line} line - The lyric line to place.
   * @returns {number} Start of the line in lyric-clock milliseconds.
   */
  const startOf = useCallback(
    (line: Line) => line.words?.find((word) => word?.at != null)?.at ?? line.at,
    []);

  /**
   * The time range a line actually occupies.
   *
   * Prefers the aligned characters, which are what the view paints. Lines the model
   * could not place have no characters, so they fall back to the outside line time and
   * run until the next line begins — without that they would never count as sounding
   * and would never light up at all.
   *
   * @param {Line} line - A lyric line, possibly carrying aligned words.
   * @param {Line} [next] - The following line, used to end an unaligned line's range.
   * @returns {[number, number] | null} Start and end in lyric-clock milliseconds.
   */
  const spanOf = useCallback((line: Line, next?: Line): [number, number] | null => {
    const chars = (line.words ?? []).flatMap((word) => word?.chars ?? []);
    if (chars.length) {
      return [chars[0].at, Math.max(...chars.map((one) => one.end ?? one.at))];
    }
    if (line.at == null) return null;
    return [line.at, next?.at ?? line.at + FALLBACK_SPAN];
  }, []);

  /**
   * Every line sounding right now, and which of them the view should centre on.
   *
   * Two voices singing together is normal once lanes exist, and lighting only one of
   * them hides half the song. So the view lights all sounding lines and anchors its
   * scroll on the lowest lane among them — the lead keeps the eye while a backing line
   * appears alongside in its own colour.
   *
   * When nothing is sounding, such as an instrumental gap, both fall back to the last
   * line already started so the view holds its place instead of going blank.
   *
   * @returns {{singing: number[], anchor: number}} Sounding line indexes, and the index
   *   to centre on. `anchor` is -1 before the first line begins.
   */
  const { singing, anchor } = useMemo(() => {
    const at = nowMs - offset;
    const live: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const range = spanOf(lines[i], lines[i + 1]);
      if (range && at >= range[0] && at < range[1]) live.push(i);
    }
    if (live.length) {
      const lead = live.reduce((best, one) =>
        (lines[one].lane ?? 0) < (lines[best].lane ?? 0) ? one : best, live[0]);
      return { singing: live, anchor: lead };
    }
    let found = -1;
    for (let i = 0; i < lines.length; i++) {
      if (startOf(lines[i]) <= at) found = i;
    }
    return { singing: found >= 0 ? [found] : [], anchor: found };
  }, [lines, nowMs, offset, startOf, spanOf]);

  /**
   * Saves a change to the open song and mirrors it into the list row.
   *
   * @async
   * @param {Partial<Song>} change - The fields to update on the open song.
   * @returns {Promise<void>} Resolves once both the open song and its row have been updated.
   */
  const patch = useCallback(async (change: Partial<Song>) => {
    if (!song) return;
    const got = await editSong(song.id, change);
    setSong(got);
    setSongs((all) => all.map((row) => (row.id === got.id ? { ...row, ...got } : row)));
  }, [song]);

  /**
   * Why there is a single save path, and why hand editing is gone.
   *
   * Lines and words live in the same array, so they share one save path. An earlier version
   * gave each of them its own timer. Dragging a line marker changes the line time and that
   * line's words together, and the two saves wiped each other's timer; whichever was
   * scheduled later sent an old array carrying only its own change and reverted the other.
   *
   * The word-saving code (`keep`, `shiftLine`, `saveWords`) has been torn out. Nobody fixes
   * times by hand any more, so there is nothing to save — alignment writes straight to the
   * database. It must not be left behind. Leaving the times editable lets **a model's mistake
   * be laundered through a human hand into ground truth**, and that ground truth is then used
   * to measure the model again. That is exactly the loop written down in §4.
   */

  /**
   * Watches an alignment run through to the end.
   *
   * Runs the server scheduled by itself land here too — nobody presses "align with the
   * model". A person's only job is review, and what the model produced is the thing being
   * reviewed. What the view used to lay down was "the line's span divided by its character
   * count", which has nothing to do with the sound; what comes out of here are positions
   * found by actually listening — still **a starting point, not ground truth**, and only
   * worth something once a person has been over it.
   *
   * Polls every 0.7 s. At 2 s the stages flew past and the terminal filled in fits and
   * starts — a song whose stems are cached takes 13 s end to end, which leaves only two or
   * three looks.
   *
   * @param {number} id - Database id of the song being aligned.
   * @returns {() => void} Teardown that stops the polling.
   */
  const watchAlign = useCallback((id: number) => {
    //: 아직 시작 안 한 새 판을, 앞판이 남긴 `done` 으로 끝났다고 보면 안 된다. 지켜보기를 부름
    //: 보다 먼저 켜기 때문에 첫 물음이 서버에 닿을 때 그 곡의 상태가 아직 지난번 `done` 일 수
    //: 있다. 한 번이라도 도는 상태를 본 뒤에만 `done` 을 믿는다.
    let began = false;
    const tick = window.setInterval(async () => {
      const beat = await alignState(id).catch(() => ({ state: "실패: 서버에 못 닿음", log: [] as Beat[] }));
      if (beat.log?.length) setLog(beat.log);
      if (!beat.state.startsWith("done") && !beat.state.startsWith("실패")) began = true;
      if (!began) return;
      if (beat.state.startsWith("done")) {
        window.clearInterval(tick); setAligning("");
        const [, count] = beat.state.split(" ");
        say(`모델이 ${count} 줄을 맞췄습니다 — 들어 보고 판정하세요`, "work");
        await open(id);
      } else if (beat.state.startsWith("실패")) {
        window.clearInterval(tick); setAligning(""); say(beat.state, "bad");
      } else {
        setAligning(beat.state);
      }
    }, 700);
    return () => window.clearInterval(tick);
  }, [say, open]);

  /**
   * The alignment a person triggers by hand. **It rebuilds the stems from scratch.**
   *
   * Reusing the cache prints "vocals extracted · 0 s", but a person pressing this means
   * "from the beginning, with the code as it stands now". Fixing the separator and then
   * aligning against the old stems tells you nothing about what the fix did. It costs that
   * much longer (2-4 minutes per song), so the terminal shows what is running the whole way.
   *
   * There is **only one** watcher. A second identical polling loop lived here once and never
   * called `setLog`, so the terminal never appeared — writing the same job in two places
   * guarantees the two will diverge.
   *
   * @async
   * @returns {Promise<void>} Resolves once the run has started and the watcher is attached.
   * @throws {Error} Never propagates; a failure to start is shown as a red toast instead.
   */
  const runAlign = useCallback(async () => {
    if (!song) return;
    setAligning("보컬 뽑는 중");
    setLog([]); setShowLog(true);
    //: 지켜보기를 **먼저** 켠다. 앞판은 이 부름이 돌아오기를 기다린 뒤에 켰는데, 서버가 다른
    //: 곡을 가르느라 바쁘면 그 부름이 몇 분씩 안 돌아온다 — 그 동안 화면은 「서버에 거는 중…」
    //: 한 줄에서 굳어 있고, 정작 서버는 잘 돌고 있다. 사람이 「여기서 멈췄다」고 한 자리다.
    watchAlign(song.id);
    startAlign(song.id, true).catch((error) => {
      setAligning(""); say(String((error as Error).message), "bad");
    });
  }, [song, say, watchAlign]);

  /**
   * Starts watching the moment an unaligned song is opened.
   *
   * The server already schedules the run in `GET /api/songs/{id}`, so there is no need to
   * schedule it again here. The view only has to show **what is running right now** —
   * without that you sit in front of empty lyrics wondering why nothing comes up.
   */
  useEffect(() => {
    if (!song || !song.has_audio || aligning) return;
    if (song.lines?.some((one) => one.words?.length)) return;
    setAligning("보컬 뽑는 중");
    setLog([]); setShowLog(true);
    return watchAlign(song.id);
  }, [song, aligning, watchAlign]);

  /**
   * Applies a pick made in the finder: either swap the audio, or add a new song.
   *
   * In `audio` mode the chosen video replaces the open song's audio and the song is reopened.
   * Otherwise a lyric hit becomes a new song; when the pick carried no video of its own,
   * YouTube is searched for the artist and title and the candidate whose duration sits
   * closest to the lyrics' duration wins. Anything thrown along the way surfaces as a red
   * toast rather than breaking the view.
   *
   * @async
   * @param {{lyric?: LyricHit, audio?: AudioHit}} pick - What the finder handed back.
   * @returns {Promise<void>} Resolves once the pick has been applied.
   */
  const onPick = useCallback(async ({ lyric, audio: picked }: { lyric?: LyricHit; audio?: AudioHit }) => {
    setFinder(null);
    try {
      if (finder === "audio" && picked && song) {
        await patch({ video_id: picked.video_id });
        say("음원 바꿈", "work"); await open(song.id); return;
      }
      if (!lyric) return;
      let videoId = picked?.video_id;
      if (!videoId) {
        say("음원 찾는 중");
        const found = await fetch(`/api/youtube?q=${encodeURIComponent(`${lyric.artist} ${lyric.title}`)}&want=5`);
        const rows: AudioHit[] = await found.json();
        videoId = rows.filter((row) => row.duration)
          .sort((a, b) => Math.abs(a.duration - lyric.duration) - Math.abs(b.duration - lyric.duration))[0]?.video_id;
      }
      if (!videoId) { say("음원을 못 찾음", "bad"); return; }
      const made = await addSong({
        video_id: videoId, artist: lyric.artist, title: lyric.title,
        duration: lyric.duration, lines: lyric.lines,
      });
      await refresh(); await open(made.id); say(`넣었습니다 — ${made.artist} ${made.title}`, "work");
    } catch (error) {
      say(String((error as Error).message), "bad");
    }
  }, [finder, song, patch, open, refresh, say]);

  /**
   * The song list narrowed by whatever is typed in the search box.
   *
   * @returns {Song[]} Songs whose artist or title contains the trimmed, lower-cased needle,
   *   or every song when the box is empty.
   */
  const shown = useMemo(() => {
    const dust = needle.trim().toLowerCase();
    return dust ? songs.filter((row) => `${row.artist} ${row.title}`.toLowerCase().includes(dust)) : songs;
  }, [songs, needle]);

  /**
   * Verdict counts for the chips at the top of the rail.
   *
   * @returns {ReadonlyArray<readonly [string, number]>} Label and count pairs, in order:
   *   total, good, off, wrong, and not yet heard.
   */
  const tally = useMemo(() => {
    const count = (verdict: Verdict) => songs.filter((row) => row.verdict === verdict).length;
    return [["전체", songs.length], ["맞음", count("good")], ["밀림", count("off")],
            ["틀림", count("wrong")], ["안 들음", songs.filter((row) => !row.verdict).length]] as const;
  }, [songs]);

  return (
    <div className="app">
      <aside className="rail">
        <div className="rail-top">
          <div className="brand">정답 검수</div>
          <div className="tally">
            {tally.map(([label, n]) => (
              <span className="chip" key={label}>{label} <b>{n}</b></span>
            ))}
          </div>
        </div>
        <div className="rail-find">
          {/* What gets typed here is the query. Songs already in the library are filtered in
              place, and anything not there is looked up and added — labelling it "filter the
              list" alone made people type a search and get nothing back. */}
          <input
            placeholder="곡 찾기 — 아티스트나 제목"
            value={needle}
            onChange={(event) => setNeedle(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") setFinder("both"); }}
          />
          <button className="plus" onClick={() => setFinder("both")} title="곡 넣기">+</button>
        </div>
        <div className="rail-list">
          {needle.trim() && (
            <button className="seek-add" onClick={() => setFinder("both")}>
              <b>“{needle.trim()}”</b> 찾아서 넣기 <kbd>Enter</kbd>
            </button>
          )}
          {shown.length === 0 && (
            <div className="pane-empty">
              {songs.length === 0
                ? "아직 곡이 없습니다.\n위에 이름을 치고 Enter 를 누르세요."
                : "담긴 곡 중에는 없습니다."}
            </div>
          )}
          {shown.map((row) => (
            <button key={row.id} className="row" onClick={() => open(row.id)}>
              {song?.id === row.id && (
                <motion.span className="row-mark" layoutId="rowMark"
                  transition={{ type: "spring", stiffness: 420, damping: 34 }} />
              )}
              <div className="row-name">
                <span className={`dot ${row.verdict ?? "none"}`} />{row.title}
              </div>
              <div className="row-sub">{row.artist} · {row.line_count}줄</div>
            </button>
          ))}
        </div>
      </aside>

      <main className="stage">
        <motion.div className="aura"
          animate={{ opacity: playing ? [0.72, 1, 0.72] : 0.45 }}
          transition={{ duration: 7, repeat: playing ? Infinity : 0, ease: "easeInOut" }} />

        <div className="head">
          <div className="head-meta">
            <div className="t">
              <input value={song?.title ?? ""} placeholder="제목" disabled={!song}
                onChange={(event) => song && setSong({ ...song, title: event.target.value })}
                onBlur={(event) => song && patch({ title: event.target.value }).then(() => say("제목 저장", "work"))} />
            </div>
            <div className="a">
              <input value={song?.artist ?? ""} placeholder="아티스트" disabled={!song}
                onChange={(event) => song && setSong({ ...song, artist: event.target.value })}
                onBlur={(event) => song && patch({ artist: event.target.value }).then(() => say("아티스트 저장", "work"))} />
            </div>
          </div>
          {/*
            What a person does here is **one thing: the verdict**. Aligning is the model's
            job, so only the verdict sits up front and the rest folds away — seven buttons of
            equal weight standing in one row make it unreadable what this screen is for.
          */}
          <div className="acts">
            <div className="verdicts">
              {([["good", "맞음"], ["off", "밀림"], ["wrong", "틀림"]] as const).map(([key, label]) => (
                <button key={key} disabled={!song}
                  className={`verdict ${key} ${song?.verdict === key ? "on" : ""}`}
                  onClick={() => {
                    const next = song?.verdict === key ? null : key;
                    patch({ verdict: next });
                    say(next ? `${label} 으로 표시` : "표시 지움", next === "wrong" ? "bad" : "work");
                  }}>{label}</button>
              ))}
            </div>
            {aligning && (
              <span className="act-busy"><span className="spin" /> {aligning}</span>
            )}
            {/* The window-wide "press outside to close" would otherwise reach in here and
                shut the menu the instant it opened. Presses inside it are not let out. */}
            <div className="more" onPointerDown={(event) => event.stopPropagation()}>
              <button className="act ghost" disabled={!song} onClick={() => setMenu((on) => !on)}
                title="그 밖의 일">⋯</button>
              <AnimatePresence>
                {menu && (
                  <motion.div className="more-list"
                    initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.14 }}
                    onMouseLeave={() => setMenu(false)}
                  >
                    <button disabled={!song || !!aligning}
                      onClick={() => { setMenu(false); runAlign(); }}
                      title="갈래부터 다시 만든다 · 곡당 2~4분">처음부터 다시 맞추기</button>
                    <button disabled={!song}
                      onClick={() => { setMenu(false); setFinder("audio"); }}>음원 바꾸기</button>
                    <button onClick={() => { setMenu(false); location.href = "/api/export"; }}>
                      정답 내보내기
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>

        {song && (
          <div className="tabs">
            {/* It is a "timeline", not "tap the words". Stamping by hand is gone, and this
                screen is where the eye runs over what the model laid down. */}
            {([["listen", "듣기"], ["tap", "타임라인"], ["shop", "작업실"]] as const).map(([key, label]) => (
              <button key={key} className={`tab ${tab === key ? "on" : ""}`} onClick={() => setTab(key)}>
                {label}
                {tab === key && <motion.span className="tab-mark" layoutId="tabMark"
                  transition={{ type: "spring", stiffness: 420, damping: 32 }} />}
              </button>
            ))}
            {/*
              "Tap here" is gone. Nobody places words by hand any more — getting them exactly
              right is the model's job, and a person listens to the result and only judges it.
              Leaving them editable would let **a model's mistake harden into ground truth by
              way of a human hand.**

              All three screens watch the same playback position, so moving between them never
              loses your place.
            */}
            <div className="tab-nav">
              {stem !== "origin" && (
                <button className="stem-now" onClick={() => song && swapStem("origin", `/audio/${song.video_id}`)}>
                  {stem === "vocals" ? "보컬" : stem === "lead" ? "리드" : "서브"} 듣는 중 · 원본으로
                </button>
              )}
              <span>{clock(nowMs / 1000)} 지점</span>
            </div>
          </div>
        )}

        {!song ? (
          <div className="empty-note">왼쪽 ＋ 로 곡을 찾아 넣으세요. 가사는 LRCLIB, 음원은 유튜브에서 가져옵니다.</div>
        ) : tab === "listen" ? (
          <Lyrics lines={lines} offsetMs={offset} anchor={anchor} singing={singing}
                  nowMs={nowMs} onSeek={seek} />
        ) : tab === "shop" ? (
          <Workspace songId={song.id} stem={stem} onStem={swapStem}
                     nowMs={nowMs} totalMs={total || song.duration * 1000}
                     busy={Boolean(aligning)} />
        ) : (
          /* The audio time is passed through as it is. The offset is what the timeline uses
             to shift the lyrics it draws — the seek bar is the real playback position and must
             not jump because of a correction. */
          <Timeline
            key={song.id}
            lines={lines} nowMs={nowMs} offsetMs={offset}
            durationMs={total || song.duration * 1000} onSeek={seek}
          />
        )}

        <div className="foot">
          <div className="foot-bar">
            <button className="play" onClick={toggle} disabled={!song || !!pulling}>
              {pulling ? <span className="spin dark" /> : playing ? "❚❚" : "▶"}
            </button>
            <span className="stamp">{clock(nowMs / 1000)}</span>
            <div className="seek" onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              if (total) seek(((event.clientX - box.left) / box.width) * total);
            }}>
              <div className="seek-track" />
              <div className="seek-fill" style={{ width: `${total ? (nowMs / total) * 100 : 0}%` }} />
              <div className="seek-knob" style={{ left: `${total ? (nowMs / total) * 100 : 0}%` }} />
            </div>
            <span className="stamp">{clock(total / 1000)}</span>
          </div>
          <div className="foot-nudge">
            <span>치우침 보정</span>
            {[-500, -100, 100, 500].map((step) => (
              <button key={step} disabled={!song}
                onClick={() => {
                  const next = (song?.offset_ms ?? 0) + step;
                  patch({ offset_ms: next });
                  say(`치우침 ${next > 0 ? "+" : ""}${next} ms`);
                }}>
                {step > 0 ? "+" : "−"}{Math.abs(step) / 1000}초
              </button>
            ))}
            <span className="offv">{offset} ms</span>
            <button disabled={!song} onClick={() => { patch({ offset_ms: 0 }); say("치우침 되돌림"); }}>되돌리기</button>
            {/* Playback rate. Dropping to 0.5x while stamping words lets the hand keep up.
                Pitch is left alone — the browser preserves it by default, so the lyrics stay
                intelligible. */}
            <span className="rate">
              <span>배속</span>
              {[0.5, 0.75, 1, 1.25, 1.5].map((one) => (
                <button key={one} className={rate === one ? "on" : ""}
                  onClick={() => {
                    setRate(one);
                    if (audio.current) audio.current.playbackRate = one;
                  }}>{one}×</button>
              ))}
            </span>
            <span style={{ marginLeft: "auto" }}>
              {state && <><span className="spin" /> {state}</>}
            </span>
          </div>
        </div>
      </main>

      {/* Attaching a new source drops the playback rate back to 1, so the chosen rate is put
          back on once metadata has loaded. */}
      <audio
        ref={audio} preload="metadata"
        onTimeUpdate={(event) => setNowMs(event.currentTarget.currentTime * 1000)}
        onLoadedMetadata={(event) => {
          setTotal(event.currentTarget.duration * 1000);
          event.currentTarget.playbackRate = rate;
        }}
        onEnded={() => setPlaying(false)}
      />

      {/* The terminal for an alignment run. It stays after the run ends until a person closes
          it — there has to be somewhere to read what happened. It is shown even before any
          trace has arrived, so that "I pressed it and nothing happened" never occurs. */}
      <AnimatePresence>
        {showLog && (
          <Console log={log} running={Boolean(aligning)} onClose={() => setShowLog(false)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {finder && (
          /* Swapping only the audio seeds the finder with the open song's name; adding a new
             song seeds it with whatever was being typed in the rail. */
          <Finder
            mode={finder}
            seedArtist={finder === "audio" ? song?.artist : needle.trim()}
            seedTitle={finder === "audio" ? song?.title : ""}
            wantSeconds={finder === "audio" ? song?.duration : undefined}
            onClose={() => setFinder(null)} onPick={onPick}
          />
        )}
      </AnimatePresence>

      {/* Audio being fetched. It takes about twenty seconds and playback is dead throughout,
          so what is being waited on stays visible the whole time. As small print in the bottom
          corner it went unseen and people just kept hammering the play button. */}
      <AnimatePresence>
        {pulling && (
          <motion.div className="pulling"
            initial={{ opacity: 0, y: 14, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 340, damping: 28 }}>
            <span className="spin" />
            <span className="pulling-main">
              <b>음원 받는 중</b>
              <span className="pulling-song">{pulling.title}</span>
            </span>
            <span className="pulling-clock">{waited}초</span>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {notes.map((one, index) => (
          <motion.div
            key={one.id}
            className={`note ${one.kind}`}
            style={{ bottom: 24 + (notes.length - 1 - index) * 58 + (pulling ? 74 : 0) }}
            initial={{ opacity: 0, x: 24, scale: 0.96 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 16, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
          >
            {one.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
