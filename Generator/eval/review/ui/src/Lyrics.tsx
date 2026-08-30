/**
 * An imitation of what Apple Music does.
 *
 * This is not scrolling. Every line has a place of its own, and when the current line changes
 * **every line moves to a new place of its own.** The browser's `scrollTo({behavior:"smooth"})`
 * has no spring, so it glides to a stop, and the lines are dragged along as one block — which
 * does not give that feeling.
 *
 * Three things make the impression:
 *
 *   * **Spring** — it overshoots its resting place a little and comes back. That gives the weight
 *     of a stack of paper settling.
 *   * **Staggered departure** — the lines **below** the current one leave 0.045 s later, one per
 *     line. Moving all at once makes the slab jump; moving out of step reads as a stack settling
 *     into place. Nothing further than three lines down is delayed any more than that — delaying
 *     past there means the bottom is still tidying itself long after the current line has gone by.
 *   * **Fading the top and bottom edges** — a line fades out instead of being cut off.
 *
 * Line heights are measured, not assumed. Reprise cuts every line to one row and uses a fixed
 * height, but Korean lyrics wrap often, so a fixed height goes out of alignment.
 */

import { motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Line } from "./api";
import { clock } from "./api";

interface Props {
  lines: Line[];
  offsetMs: number;
  /** Index the view centres on — the lead among the lines sounding now. */
  anchor: number;
  /** Every line sounding now. Two voices at once is normal once lanes exist. */
  singing: number[];
  /** Current playback position in ms. Audio time, with no correction subtracted. */
  nowMs: number;
  onSeek: (ms: number) => void;
}

/**
 * Paint one grain — a character or a word. Grey turns white from left to right.
 *
 * At 0 and 1 the grain is painted a flat colour. Leaving the gradient in place at those ends
 * leaves a white thread on the left edge of a grain that has not been sung yet — the first two
 * stops are both at 0%, so the space between them bleeds.
 *
 * The fill is deliberately not wrapped in motion, because it changes every frame. Put a spring on
 * it and the fill falls behind the sound, and that lag is exactly what reads as "it does not
 * match".
 *
 * @param {object} props - Component props.
 * @param {string} props.text - The character or word to paint.
 * @param {number} props.at - When the grain starts, in ms, with the correction already applied.
 * @param {number} props.end - When the grain ends, in ms, with the correction already applied.
 * @param {number} props.nowMs - Current playback position in ms; -1 leaves the grain unsung.
 * @returns {JSX.Element} A span carrying the fill fraction as the `--filled` custom property.
 */
function Ink({ text, at, end, nowMs }: { text: string; at: number; end: number; nowMs: number }) {
  const filled = Math.min(1, Math.max(0, (nowMs - at) / Math.max(1, end - at)));
  return (
    <span
      className={`word ${filled <= 0 ? "none" : filled >= 1 ? "full" : ""}`}
      style={{ "--filled": `${filled * 100}%` } as React.CSSProperties}
    >
      {text}
    </span>
  );
}

/**
 * Paint the current line split into words — only when recorded word times exist.
 *
 * Lighting the line as a whole leaves an eight-second line lit in one piece, so there is no
 * telling which part is being sung. The words have to light one at a time for the reader to
 * follow along — that is the whole reason word times are produced in the first place.
 *
 * When character times exist, each character is painted on its own. In Korean one character is one
 * syllable, and that is the unit by which the song is followed — if 「떠나보내고」 fills as one
 * block there is no telling where the singing is, and it is common for that one word to take
 * 3 seconds.
 *
 * The space between words is kept outside the span. Inside an inline-block the trailing space is
 * squeezed out and the words end up stuck to each other.
 *
 * @param {object} props - Component props.
 * @param {Line} props.line - The line to draw.
 * @param {number} props.offsetMs - Correction added to every recorded time, in ms.
 * @param {number} props.nowMs - Current playback position in ms; -1 leaves every word unsung.
 * @returns {JSX.Element} The painted words, or the plain line text when there are no word times.
 */
/**
 * Fill in a line word by word as it is sung.
 *
 * A word may carry a lane of its own, and then it overrides the line's. Lyric sheets write
 * `(If, if I got a, if I got a) would you guarantee?` as one line although the bracketed run is
 * the backing singer and the tail is the lead, so a colour per line painted the whole thing one
 * voice. `--voice` is set on the word's own wrapper, and because the line already sets the same
 * variable, a word without a lane inherits it and nothing else has to know about this.
 *
 * @param {object} props - Component props.
 * @param {Line} props.line - The line to draw, with its word and character timings.
 * @param {number} props.offsetMs - Shift applied to every time, for nudging against the audio.
 * @param {number} props.nowMs - Where the song is now, or -1 for a line that is not sounding.
 * @returns {JSX.Element} The line's words, each filled to the point it has been sung.
 */
function Sung({ line, offsetMs, nowMs }: { line: Line; offsetMs: number; nowMs: number }) {
  const words = line.words?.filter((word) => word && word.at != null) ?? [];
  if (!words.length) return <>{line.text}</>;
  return (
    <>
      {words.map((word, index) => (
        <span key={index}
              style={word.lane == null ? undefined : {
                "--voice": VOICES[Math.min(VOICES.length - 1, Math.max(0, word.lane))],
              } as React.CSSProperties}>
          {word.chars?.length
            ? word.chars.map((grain, at) => (
                <Ink key={at} text={grain.text}
                     at={grain.at + offsetMs} end={grain.end + offsetMs} nowMs={nowMs} />
              ))
            : <Ink text={word.text}
                   at={word.at! + offsetMs}
                   end={(word.end ?? word.at! + 400) + offsetMs} nowMs={nowMs} />}
          {index < words.length - 1 ? " " : ""}
        </span>
      ))}
    </>
  );
}

/**
 * One colour per voice.
 *
 * Karaoke changes the colour that fills in — the unsung grey is left alone and **only the filled
 * side** differs. That keeps "how far has it been sung" and "who is singing" from hiding each
 * other.
 *
 * They were chosen to sit at a similar brightness on a dark ground. If one of them stands out,
 * that singer looks more important than the others.
 */
const VOICES = ["#f4f2ef", "#8fd8ff", "#ffc48a"];

/** Where in the window the current line sits, as a fraction of height. Dead centre folds the next line out of sight. */
const ANCHOR = 0.34;
/** How much later each successive line below the current one departs, in seconds. */
const CASCADE = 0.045;
/** How many lines below the current one are delayed at all. */
const CASCADE_MAX = 3;
/** How long a hand-scroll holds before the view drifts back to the playing line, in ms. */
const HOLD_SCROLL = 2600;

/**
 * The lyric view — every line held at a place of its own, springing to a new one as the song runs.
 *
 * The resting places are re-measured whenever the window resizes, because the seat of each line
 * moves with it.
 *
 * A hand push is applied to the **outer box**, never added to each line's y. Added per line, the
 * spring catches on every wheel tick and the whole thing turns sticky — the spring is there to
 * follow the song, not to follow a hand. Here it has to move at once to feel attached to the
 * finger.
 *
 * Lines blur further out the further they are, clamped at three lines away: past that the
 * difference is invisible while the browser still pays for it. The current line is not blurred at
 * all, because its words paint their own colour. Lines below the current one leave a little later,
 * one after another; lines above are never delayed — a line that has already gone by, dawdling,
 * pulls the eye back to it.
 *
 * Clicking a line seeks to **that line's first character**, not to the line time that came from
 * outside: the line time is off by more than a second, which reads as "I pressed it and it started
 * somewhere else". The push is cleared **first**, or the view moves twice — once to the pressed
 * line, then again 2.6 s later as the push is released. That second move overlaps the spring and
 * takes the lines clean off screen and back, which is what "the page went blank and came back"
 * was.
 *
 * Both style values are set in **one** object. Giving one element `style` twice means **the later
 * one replaces the earlier one whole** — the voice colour was attached separately and was wiped
 * out by zIndex, and the type checker does not catch this.
 *
 * Lines that are not the current one are still drawn as words. Redrawing them as plain text turns
 * the whole line white for that instant and then fades it late, so every line change flashes
 * white. Passing `nowMs` as -1 puts every word in the unsung (grey) state instead.
 *
 * Broken lines are flagged. "Which line do I have to listen to first" is the first question of a
 * review, and per-character confidence is too weak in this model to answer it. The flag reads
 * contradictions inside the alignment result instead, so it does not wobble when the audio master
 * changes.
 *
 * @param {Props} props - Component props.
 * @param {Line[]} props.lines - Every line of the song, in order.
 * @param {number} props.offsetMs - Correction added to every recorded time, in ms.
 * @param {number} props.anchor - Index the view centres on — the lead among the lines sounding now.
 * @param {number[]} props.singing - Every line sounding now.
 * @param {number} props.nowMs - Current playback position in ms, uncorrected audio time.
 * @param {(ms: number) => void} props.onSeek - Called with the time to seek to when a line is pressed.
 * @returns {JSX.Element} The scrolling-free lyric stage.
 */
export function Lyrics({ lines, offsetMs, anchor, singing, nowMs, onSeek }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const nodes = useRef<(HTMLButtonElement | null)[]>([]);
  const [tops, setTops] = useState<number[]>([]);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    /**
     * Measure and stack the resting place of every line.
     *
     * The heights are measured and accumulated rather than assumed, because lines wrap and so
     * every height differs.
     *
     * @returns {void}
     */
    const measure = () => {
      let run = 0;
      const next: number[] = [];
      for (const node of nodes.current) {
        next.push(run);
        run += node ? node.offsetHeight + 6 : 0;
      }
      setTops(next);
      setHeight(box.current?.clientHeight ?? 0);
    };
    measure();
    const watch = new ResizeObserver(measure);
    if (box.current) watch.observe(box.current);
    for (const node of nodes.current) if (node) watch.observe(node);
    return () => watch.disconnect();
  }, [lines]);

  useEffect(() => {
    const onResize = () => setHeight(box.current?.clientHeight ?? 0);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const focused = Math.max(0, anchor);
  const live = new Set(singing);
  /** Where in the window the focused line sits, in pixels. */
  const restAt = height * ANCHOR;
  const base = tops[focused] ?? 0;
  /**
   * Whether this line is a second voice sounding alongside the focused one.
   *
   * Such a line is drawn smaller in its own place rather than copied beneath the focused
   * line. Copying it put the same words on screen twice — once small under the lead and
   * once full-size in the list — which read as the view breaking.
   */
  const alongside = (index: number) => live.has(index) && index !== focused;

  /**
   * How far the reader has pushed the lyrics away from the playing line, in pixels.
   *
   * The view normally rides the playhead, which is right while listening but leaves no
   * way to read ahead or look back at a line that already passed. Scrolling adds that
   * without giving up the follow: the push decays after a pause and the view returns to
   * the playing line on its own.
   */
  const [drift, setDrift] = useState(0);
  const pushed = useRef(0);
  /** Last touch position, for turning finger drags into pushes. */
  const reachedAt = useRef(0);

  useEffect(() => {
    if (!drift) return;
    const tick = window.setInterval(() => {
      if (Date.now() - pushed.current > HOLD_SCROLL) setDrift(0);
    }, 400);
    return () => window.clearInterval(tick);
  }, [drift]);

  /** Reset the push whenever the song changes, so a new song opens at its first line. */
  useEffect(() => { setDrift(0); }, [lines]);

  const reach = tops.length ? (tops[tops.length - 1] ?? 0) : 0;

  /**
   * Push the lyrics by a wheel or trackpad gesture.
   *
   * Clamped to the song's own extent so the text cannot be flung into empty space, and
   * timestamped so the decay above knows when the reader stopped.
   *
   * @param {number} by - Pixels to move, positive scrolls toward later lines.
   */
  const push = useCallback((by: number) => {
    pushed.current = Date.now();
    setDrift((was) => Math.max(-reach - restAt, Math.min(reach + restAt, was - by)));
  }, [reach, restAt]);

  return (
    <div className="lyric-wrap" ref={box}
      onWheel={(event) => push(event.deltaY)}
      onTouchStart={(event) => { pushed.current = Date.now(); reachedAt.current = event.touches[0].clientY; }}
      onTouchMove={(event) => {
        const y = event.touches[0].clientY;
        push(reachedAt.current - y);
        reachedAt.current = y;
      }}
    >
      <div className="lyric-stage" style={{ transform: `translateY(${drift}px)` }}>
        {lines.map((line, index) => {
          const away = index - focused;
          const now = live.has(index);
          const far = Math.min(Math.abs(away), 3);
          return (
            <motion.button
              key={index}
              ref={(element) => { nodes.current[index] = element; }}
              className={`lyric ${now ? "now" : ""} ${alongside(index) ? "second" : ""}`}
              onClick={() => {
                setDrift(0);
                onSeek((line.words?.find((one) => one?.at != null)?.at ?? line.at) + offsetMs);
              }}
              initial={false}
              animate={{
                y: (tops[index] ?? 0) - base + restAt,
                opacity: now ? 1 : away < 0 ? 0.6 : 0.72 - far * 0.05,
                filter: now ? "blur(0px)" : `blur(${0.4 + far * 0.45}px)`,
                scale: alongside(index) ? 0.72 : now ? 1.03 : 1,
              }}
              transition={{
                y: {
                  type: "spring", duration: 0.56, bounce: 0.24,
                  delay: Math.min(Math.max(away, 0), CASCADE_MAX) * CASCADE,
                },
                opacity: { duration: 0.24 },
                filter: { duration: 0.32 },
                scale: { type: "spring", duration: 0.5, bounce: 0.3 },
              }}
              style={{
                zIndex: now ? 1 : 0,
                "--voice": VOICES[Math.min(VOICES.length - 1, Math.max(0, line.lane ?? 0))],
              } as React.CSSProperties}
              whileHover={{ opacity: 1, filter: "blur(0px)" }}
            >
              <Sung line={line} offsetMs={offsetMs} nowMs={now ? nowMs : -1} />
              <span className="lyric-at">{clock((line.at + offsetMs) / 1000)}</span>
              {line.words?.[0]?.stuck && (
                <span className="lyric-stuck" title={line.words[0].stuck}>무너짐</span>
              )}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
