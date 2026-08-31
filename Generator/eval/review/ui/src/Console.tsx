/**
 * Stacks the trace of a matching run and shows it like a terminal.
 *
 * A one-line status was not enough. A single song takes 3-5 minutes, and when only
 * "extracting vocals" is on screen there is **no way to tell whether it is stuck or
 * merely slow**, and once it finishes nothing is left of what happened. Stacking the
 * lines lets a person read and judge on the spot - how many seconds it took, which
 * branch was taken, how many lines broke.
 */
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

/**
 * One line of the run log.
 *
 * Each beat is a single event the server emitted during the run, carrying its own
 * timestamp so elapsed time can be derived on the client instead of being sent.
 */
export interface Beat {
  /** Unix time in seconds. Stamped by the server. */
  at: number;
  /** The line of text shown to the reader. */
  text: string;
  /** Which kind of line it is, which drives the styling of the row. */
  kind: "step" | "done" | "bad";
}

/**
 * Props of the console panel.
 */
interface Props {
  /** Beats to render, oldest first. */
  log: Beat[];
  /** Whether the run is still going. When it has finished, no cursor is left on the last line. */
  running: boolean;
  /** Called when the close button is pressed. */
  onClose: () => void;
}

/**
 * Format how many seconds have passed since the first line of the log.
 *
 * The timestamp column is rendered relative to the first beat rather than as an
 * absolute clock time, because "how long did it take" is what actually reads off the
 * screen. When the log is empty the given timestamp is used as its own origin, which
 * yields 00:00, and the gap is clamped at zero so a beat stamped before the first one
 * cannot render as a negative time.
 *
 * @param {Beat[]} log - The full log; only its first entry is used, as the origin.
 * @param {number} at - Unix time in seconds of the beat being rendered.
 * @returns {string} Elapsed time as zero-padded "MM:SS".
 */
function since(log: Beat[], at: number): string {
  const first = log[0]?.at ?? at;
  const gap = Math.max(0, at - first);
  return `${String(Math.floor(gap / 60)).padStart(2, "0")}:${String(Math.floor(gap % 60)).padStart(2, "0")}`;
}

/**
 * The line shown while the server has not sent its first step yet.
 *
 * It counts, rather than standing still. A frozen `00:00 서버에 거는 중…` is what a person saw
 * when the server was busy separating another song, and there is no way to tell that from a
 * hung tool — the same one line, unchanged, for minutes. A number that keeps moving says the
 * screen is alive and the wait is the server's.
 *
 * @returns {JSX.Element} One trail line whose clock counts up from when it appeared.
 */
function Waiting() {
  const [since, setSince] = useState(0);
  useEffect(() => {
    const tick = window.setInterval(() => setSince((one) => one + 1), 1000);
    return () => window.clearInterval(tick);
  }, []);
  const mins = String(Math.floor(since / 60)).padStart(2, "0");
  const secs = String(since % 60).padStart(2, "0");
  return (
    <div className="tty-line">
      <span className="tty-at">{mins}:{secs}</span>
      <span className="tty-text">
        서버에 거는 중{since > 20 ? " — 다른 곡을 가르는 중일 수 있습니다" : "…"}
      </span>
    </div>
  );
}

/**
 * Render the terminal-like panel that holds the run log.
 *
 * When a new line arrives the body follows down to the bottom, the way a terminal
 * moves; the effect keys on the log length so that only an added line scrolls the
 * view. While nothing has arrived yet a "connecting" line is shown instead of an
 * empty body, because an empty box reads as "did it stall?". The blinking cursor is
 * drawn only while the run is going, so a finished run does not look like it is still
 * waiting for more output.
 *
 * @param {Props} props - Component props.
 * @param {Beat[]} props.log - Beats to render, oldest first.
 * @param {boolean} props.running - Whether the run is still going.
 * @param {() => void} props.onClose - Called when the close button is pressed.
 * @returns {JSX.Element} The console panel.
 */
export function Console({ log, running, onClose }: Props) {
  const tail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    tail.current?.scrollTo({ top: tail.current.scrollHeight, behavior: "smooth" });
  }, [log.length]);

  return (
    <motion.div className="tty"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12 }}
      transition={{ type: "spring", duration: 0.4, bounce: 0.2 }}
    >
      <div className="tty-bar">
        <span className="tty-name">
          {running ? <><span className="spin" /> 모델이 맞추는 중</> : "맞추기 끝"}
        </span>
        <button className="tty-close" onClick={onClose}>닫기</button>
      </div>
      <div className="tty-body" ref={tail}>
        <AnimatePresence initial={false}>
          {log.map((one, index) => (
            <motion.div key={`${one.at}-${index}`} className={`tty-line ${one.kind}`}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.18 }}
            >
              <span className="tty-at">{since(log, one.at)}</span>
              <span className="tty-text">{one.text}</span>
            </motion.div>
          ))}
        </AnimatePresence>
        {!log.length && <Waiting />}
        {running && <div className="tty-line"><span className="tty-at" /><span className="tty-cursor" /></div>}
      </div>
    </motion.div>
  );
}
