/**
 * A screen for **eyeballing** where the model placed things. It has no editing features.
 *
 * The predecessor (`Tapper`) was where a person dragged words into place one at a time. That job is
 * gone — getting the timings right is the model's work, and the human only listens and judges.
 * Leaving hand-editing in place means **a model's mistake gets frozen into ground truth by a human
 * hand.**
 *
 * So instead of patching the 700-line original, this was written from scratch. Dragging, dropping,
 * key input, pasting and undo were tangled into one another, which made "cutting out only the
 * editing parts" harder than rewriting the whole thing.
 */
import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Line } from "./api";
import { clock } from "./api";

/**
 * One lane per voice. These must stay paired with the colours on the listening screen, otherwise
 * the two screens no longer read as a single song.
 */
const LANE_NAMES = ["메인", "두 번째 목소리", "세 번째"];
/** Height in pixels of a single voice lane. */
const LANE_H = 42;
/**
 * Height in pixels of the strip above the lanes. Bars start below it.
 *
 * Tall enough for two rows, because the clock and the line numbers used to be written on the same
 * one and read as a single row of nonsense — `22.0s 7 8 28.5s 9 10 35.0s 11`.
 */
const RULER_H = 30;
/** Narrowest a bar may be (px) and still have its character drawn inside it. */
const READABLE_PX = 17;
/** Closest two line numbers may be drawn (px). Any nearer and only the marker line is kept. */
const MARKER_PX = 30;

/** One drawn grain: a single character whose times already sit on the audio clock. */
interface Bar {
  /** The character itself. */
  text: string;
  /** Start in audio time (ms), i.e. the lyric time with `offsetMs` already added. */
  at: number;
  /** End in audio time (ms). Falls back to 300 ms after `at` when the model left it open. */
  end: number;
  /** Voice lane index, clamped into the range covered by `LANE_NAMES`. */
  lane: number;
  /** Index of the line this grain came from. */
  line: number;
  /** True when the model was not confident about this grain. */
  shaky: boolean;
}

/** Inputs for {@link Timeline}. */
interface Props {
  /** Lines exactly as the model produced them. */
  lines: Line[];
  /** Current playback position (ms). Raw **audio time**, with no offset subtracted. */
  nowMs: number;
  /** Whole-song skew (ms). Adding this to a lyric time gives the audio time. */
  offsetMs: number;
  /** Length of the whole song (ms). */
  durationMs: number;
  /** Called with an audio-time position (ms) when the track is clicked. */
  onSeek: (ms: number) => void;
}

/**
 * Draws every timed character of the song as a read-only bar chart over a time ruler.
 *
 * Each character of each word is flattened into a single flat list of bars. That flattening is for
 * drawing only, so the incoming lines are never touched. Every time gets `offsetMs` added to it so
 * the bars sit on the same clock as the audio, and a character with no end time is drawn 300 ms
 * long. Characters with no start time are skipped entirely.
 *
 * The visible window is `durationMs / zoom` wide and stays centred on the playhead, except at 1x
 * where the whole song is shown centred on itself. Bars and line markers that fall outside that
 * window are dropped instead of being drawn off-screen. Clicking the track seeks to the clicked
 * position; the wheel doubles or halves the zoom between 1x and 64x.
 *
 * The bar under the playhead is marked live. That is what lets the recorded times be checked by
 * ear: play the song and watch which character lights up. The line markers sit on the first timed
 * word of each line, so it is clear which passage is on screen.
 *
 * The track's pixel width is measured rather than assumed. A bar's width is known as a percentage
 * of the window, which says nothing about whether a character fits inside it: at 8x on a
 * three-minute song a bar is about two pixels, and drawing a letter in it left only the padding,
 * so nine hundred bars read as one solid block. Both the characters and the line numbers are
 * dropped once there is no room for them, leaving the bars themselves to be read.
 *
 * @param {Props} props - Lines to draw, the playback position and offset, the song length, and the seek callback.
 * @returns {JSX.Element} The zoom controls, the ruler, the voice lanes and the character bars.
 */
export function Timeline({ lines, nowMs, offsetMs, durationMs, onSeek }: Props) {
  const [zoom, setZoom] = useState(8);
  const track = useRef<HTMLDivElement>(null);
  /** Width of the track in pixels. Percentages alone cannot say whether a bar has room for text. */
  const [wide, setWide] = useState(900);

  useEffect(() => {
    const box = track.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(([one]) => setWide(one.contentRect.width));
    watch.observe(box);
    return () => watch.disconnect();
  }, []);

  const bars = useMemo<Bar[]>(() => {
    const out: Bar[] = [];
    lines.forEach((line, index) => {
      const held = line.lane ?? 0;
      for (const word of line.words ?? []) {
        const lane = Math.min(LANE_NAMES.length - 1, Math.max(0, word?.lane ?? held));
        for (const grain of word?.chars ?? []) {
          if (grain.at == null) continue;
          out.push({
            text: grain.text, at: grain.at + offsetMs,
            end: (grain.end ?? grain.at + 300) + offsetMs,
            lane, line: index, shaky: Boolean(grain.shaky),
          });
        }
      }
    });
    return out;
  }, [lines, offsetMs]);

  const lanes = useMemo(
    () => LANE_NAMES.slice(0, bars.reduce((top, one) => Math.max(top, one.lane), 0) + 1),
    [bars]);

  const whole = Math.max(1000, durationMs);
  const span = whole / zoom;
  const middle = zoom === 1 ? whole / 2 : nowMs;
  const from = Math.min(whole - span, Math.max(0, middle - span / 2));

  /**
   * Places an audio-time position on the horizontal axis of the visible window.
   *
   * A result outside 0..100 means the position lies off-screen; callers use that to skip drawing.
   *
   * @param {number} ms - Position in audio time (ms).
   * @returns {number} Offset from the left edge of the track, as a percentage of its width.
   */
  const place = (ms: number) => ((ms - from) / span) * 100;

  const live = bars.findIndex((one) => one.at <= nowMs && nowMs < one.end);

  return (
    <div className="tap-wrap">
      <div className="bars-wrap">
        <div className="bars-tools">
          <button onClick={() => setZoom((z) => Math.max(1, z / 2))} disabled={zoom <= 1}>−</button>
          <span className="bars-zoom">{zoom}×</span>
          <button onClick={() => setZoom((z) => Math.min(64, z * 2))} disabled={zoom >= 64}>＋</button>
          <button onClick={() => setZoom(1)} disabled={zoom === 1}>곡 전체</button>
          <span className="bars-hint">
            눌러서 그 자리로 · 휠로 확대 · 글자 {bars.length}개
            {lanes.length > 1 && ` · 목소리 ${lanes.length}갈래`}
          </span>
        </div>
        <div
          ref={track}
          className="bars"
          style={{ height: RULER_H + lanes.length * LANE_H }}
          onWheel={(event) => {
            if (Math.abs(event.deltaY) < 1) return;
            event.preventDefault();
            setZoom((z) => Math.min(64, Math.max(1, event.deltaY < 0 ? z * 2 : z / 2)));
          }}
          onClick={(event) => {
            const box = track.current?.getBoundingClientRect();
            if (box) onSeek(Math.round(from + ((event.clientX - box.left) / box.width) * span));
          }}
        >
          {lanes.map((name, lane) => (
            <div key={name} className={`lane ${lane % 2 ? "odd" : ""}`}
              style={{ top: RULER_H + lane * LANE_H, height: LANE_H }}>
              {lanes.length > 1 && <span className="lane-name">{name}</span>}
            </div>
          ))}

          {[0, 0.25, 0.5, 0.75, 1].map((share) => (
            <span key={share} className="bars-tick" style={{ left: `${share * 100}%` }}>
              <i />{((from + share * span) / 1000).toFixed(2)}s
            </span>
          ))}

          {(() => {
            // The number is dropped when the line before it is too close to read, but the marker
            // line stays. Drawing every number packed the strip solid at anything past 4x.
            let told = -Infinity;
            return lines.map((line, index) => {
              const first = line.words?.find((one) => one?.at != null)?.at;
              if (first == null) return null;
              const left = place(first + offsetMs);
              if (left < -1 || left > 101) return null;
              const room = left * wide / 100 - told >= MARKER_PX;
              if (room) told = left * wide / 100;
              return (
                <span key={`l${index}`} className="bars-line read" style={{ left: `${left}%` }}
                  title={`${index + 1}번째 줄 · ${line.text.slice(0, 30)}`}>
                  {room && <b>{index + 1}</b>}
                </span>
              );
            });
          })()}

          {bars.map((one, index) => {
            const left = place(one.at);
            const width = place(one.end) - left;
            if (left > 102 || left + width < -2) return null;
            return (
              <div key={index}
                className={`bar read voice-${one.lane} ${index === live ? "live" : ""} ${one.shaky ? "unsure" : ""}`}
                style={{
                  left: `${left}%`, width: `${Math.max(0.4, width)}%`,
                  top: RULER_H + one.lane * LANE_H + 4, height: LANE_H - 8,
                }}
                title={`${one.text} · ${(one.at / 1000).toFixed(2)}s ~ ${(one.end / 1000).toFixed(2)}s`}
              >
                {width * wide / 100 >= READABLE_PX && <span className="bar-text">{one.text}</span>}
              </div>
            );
          })}

          <motion.div className="bars-now"
            style={{ left: `${Math.min(100, Math.max(0, place(nowMs)))}%` }} />
          {bars.length === 0 && (
            <span className="bars-empty-hint">아직 맞춘 글자가 없습니다 — 모델이 도는 중입니다</span>
          )}
        </div>
        <p className="bars-foot">{clock(nowMs / 1000)} / {clock(whole / 1000)}</p>
      </div>
    </div>
  );
}
