import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import type { WordSpan } from "./cursor.js";

/**
 * The song as a strip of time you can zoom into, scrub across, and drag words about on.
 *
 * The old overview drew the whole song into one bar. At three minutes across a laptop that is
 * about two pixels a word, so nothing could be judged and nothing could be grabbed — the only
 * way to move a boundary was to type an absolute millisecond figure into a table below. A word
 * is 150-400ms; to see one you need to be able to get down to a few hundred milliseconds across
 * the screen, and to fix one you want to take hold of its edge while you are listening to it.
 */

const MIN_PX_PER_MS = 0.00004; // 전체 곡이 한 화면에
const MAX_PX_PER_MS = 2; // 한 화면에 0.5초 — 낱말 하나가 손에 잡힌다
const EDGE_GRIP = 7;

export interface TimelineToken {
  index: number;
  text: string;
  line: number;
}

export interface TimelineLine {
  index: number;
  text: string;
  token_indices: number[];
}

interface Props {
  peaks: number[] | null;
  durationMs: number;
  currentMs: number;
  words: WordSpan[];
  tokens: Map<number, TimelineToken>;
  lines: TimelineLine[];
  lineSpans: Array<[number, number]>;
  asideLines: Set<number>;
  rescued: Set<number>;
  chosen: number | null;
  onChoose: (token: number) => void;
  onSeek: (ms: number) => void;
  onMove: (row: number, startMs: number, endMs: number) => void;
  unplaced: TimelineToken[];
  onPlace: (token: number) => void;
  onPlaceAt: (ms: number) => void;
  onConfirm: (token: number) => void;
}

type Grab = { row: number; edge: "start" | "end" | "body"; grabbedMs: number; from: [number, number] };

export function Timeline(props: Props): ReactElement {
  const { peaks, durationMs, currentMs, words, tokens, lines, lineSpans, asideLines, rescued, chosen, unplaced } = props;
  const viewport = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.02);
  const [left, setLeft] = useState(0);
  const [width, setWidth] = useState(1200);
  const [grab, setGrab] = useState<Grab | null>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    const element = viewport.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  const spanMs = width / scale;
  // 처음 열었을 때 아무것도 없는 자리를 보고 있으면 타임라인이 비어 보인다. 노래가
  // 시작하는 곳으로 간다 — 인트로가 길면 첫 낱말은 한참 뒤에 있다.
  const placed = useRef(false);
  useEffect(() => {
    if (placed.current || words.length === 0 || width <= 1) return;
    placed.current = true;
    const first = Math.min(...words.map((span) => span[1]));
    setLeft(Math.max(0, first - width / scale / 6));
  }, [words, width, scale]);
  // 재생 위치를 따라간다. 화면 밖으로 나가려 할 때만 옮겨, 보고 있는 자리가 흔들리지 않게.
  useEffect(() => {
    // 아직 재생 전이면 재생 위치는 0 이다. 그걸 따라가면 노래가 시작하는 자리로
    // 맞춰 놓은 화면을 곡 맨 앞으로 도로 끌고 간다.
    if (!follow || grab !== null || currentMs <= 0) return;
    if (currentMs < left + spanMs * 0.1 || currentMs > left + spanMs * 0.85) {
      setLeft(Math.max(0, Math.min(currentMs - spanMs * 0.4, durationMs - spanMs)));
    }
  }, [currentMs, follow, grab, left, spanMs, durationMs]);

  const msAt = useCallback(
    (clientX: number): number => {
      const box = viewport.current?.getBoundingClientRect();
      if (box === undefined) return 0;
      return Math.max(0, Math.min(durationMs, left + (clientX - box.left) / scale));
    },
    [durationMs, left, scale],
  );

  const zoomAt = useCallback(
    (clientX: number, factor: number): void => {
      const anchor = msAt(clientX);
      const next = Math.max(MIN_PX_PER_MS, Math.min(MAX_PX_PER_MS, scale * factor));
      const box = viewport.current?.getBoundingClientRect();
      const offset = box === undefined ? 0 : clientX - box.left;
      setScale(next);
      setLeft(Math.max(0, Math.min(anchor - offset / next, Math.max(0, durationMs - width / next))));
    },
    [durationMs, msAt, scale, width],
  );

  useEffect(() => {
    const element = viewport.current;
    if (element === null) return;
    function onWheel(event: WheelEvent): void {
      // 세로 스크롤은 확대, 가로 스크롤은 이동 — 편집기에서 몸에 익은 손놀림이다.
      if (event.ctrlKey || Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        event.preventDefault();
        zoomAt(event.clientX, event.deltaY < 0 ? 1.25 : 1 / 1.25);
        return;
      }
      event.preventDefault();
      setLeft((current) => Math.max(0, Math.min(current + event.deltaX / scale, Math.max(0, durationMs - width / scale))));
    }
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [durationMs, scale, width, zoomAt]);

  const visible = useMemo(
    () => words.map((span, row) => ({ span, row })).filter(({ span }) => span[2] >= left - spanMs * 0.2 && span[1] <= left + spanMs * 1.2),
    [words, left, spanMs],
  );

  const x = (ms: number): number => (ms - left) * scale;

  function startGrab(event: ReactPointerEvent<HTMLDivElement>, row: number, span: WordSpan): void {
    event.stopPropagation();
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const fromLeft = event.clientX - box.left;
    const edge = fromLeft <= EDGE_GRIP ? "start" : box.width - fromLeft <= EDGE_GRIP ? "end" : "body";
    // 손가락을 놓칠 때를 대비해 잡아 두되, 잡지 못해도 끌기는 계속되어야 한다.
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      /* 포인터를 잡을 수 없는 환경도 있다 */
    }
    setGrab({ row, edge, grabbedMs: msAt(event.clientX), from: [span[1], span[2]] });
    props.onChoose(span[0]);
  }

  function onGrabMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (grab === null) return;
    const shift = msAt(event.clientX) - grab.grabbedMs;
    const [was, wasEnd] = grab.from;
    if (grab.edge === "body") props.onMove(grab.row, Math.max(0, was + shift), Math.max(20, wasEnd + shift));
    else if (grab.edge === "start") props.onMove(grab.row, Math.max(0, Math.min(was + shift, wasEnd - 20)), wasEnd);
    else props.onMove(grab.row, was, Math.max(was + 20, wasEnd + shift));
  }

  const ticks = useMemo(() => {
    const steps = [10, 20, 50, 100, 250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000];
    const step = steps.find((value) => value * scale > 64) ?? 60_000;
    const marks: number[] = [];
    for (let at = Math.floor(left / step) * step; at < left + spanMs + step; at += step) if (at >= 0) marks.push(at);
    return { step, marks };
  }, [left, scale, spanMs]);

  return (
    <div className="tl">
      <div className="tl-bar">
        <button type="button" className={follow ? "on" : ""} onClick={() => setFollow((value) => !value)}>
          재생 위치 따라가기
        </button>
        <button type="button" onClick={() => zoomAt((viewport.current?.getBoundingClientRect().left ?? 0) + width / 2, 1 / 1.6)}>
          −
        </button>
        <button type="button" onClick={() => zoomAt((viewport.current?.getBoundingClientRect().left ?? 0) + width / 2, 1.6)}>
          +
        </button>
        <button
          type="button"
          onClick={() => {
            setScale(Math.max(MIN_PX_PER_MS, width / Math.max(1, durationMs)));
            setLeft(0);
          }}
        >
          전체
        </button>
        <span className="tl-scale">{formatSpan(spanMs)} 보임</span>
      </div>

      <div
        className={`tl-view${grab === null ? "" : " grabbing"}`}
        ref={viewport}
        onPointerMove={onGrabMove}
        onPointerUp={() => setGrab(null)}
        onPointerCancel={() => setGrab(null)}
      >
        <div className="tl-ruler" onPointerDown={(event) => props.onSeek(msAt(event.clientX))}>
          {ticks.marks.map((at) => (
            <span key={at} className="tl-tick" style={{ left: `${x(at)}px` }}>
              {formatTick(at, ticks.step)}
            </span>
          ))}
        </div>

        <div className="tl-track tl-wave" onPointerDown={(event) => props.onSeek(msAt(event.clientX))}>
          {peaks !== null && (
            <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
              <g transform={`translate(${x(0)}, 0) scale(${durationMs * scale}, 1)`}>
                <path
                  d={peaks
                    .map((peak, index) => {
                      const at = index / peaks.length;
                      return `M${at} ${0.5 - peak * 0.46}V${0.5 + peak * 0.46}`;
                    })
                    .join("")}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            </svg>
          )}
        </div>

        <div className="tl-track tl-lines">
          {lines.map((line, position) => {
            const span = lineSpans[position];
            if (span === undefined || span[1] < left - spanMs * 0.2 || span[0] > left + spanMs * 1.2) return null;
            return (
              <div
                key={line.index}
                className={`tl-line${asideLines.has(line.index) ? " aside" : ""}`}
                style={{ left: `${x(span[0])}px`, width: `${Math.max(2, (span[1] - span[0]) * scale)}px` }}
                title={line.text}
                onPointerDown={() => props.onSeek(span[0])}
              >
                <span>{line.text}</span>
              </div>
            );
          })}
        </div>

        <div
          className="tl-track tl-words"
          onDoubleClick={(event) => {
            if ((event.target as HTMLElement).closest(".tl-word") !== null) return;
            props.onPlaceAt(msAt(event.clientX));
          }}
        >
          {visible.map(({ span, row }) => {
            const token = tokens.get(span[0]);
            const aside = token !== undefined && asideLines.has(token.line);
            return (
              <div
                key={span[0]}
                className={`tl-word${chosen === span[0] ? " chosen" : ""}${rescued.has(span[0]) ? " rescued" : ""}${aside ? " aside" : ""}`}
                style={{ left: `${x(span[1])}px`, width: `${Math.max(3, (span[2] - span[1]) * scale)}px` } as CSSProperties}
                title={
                  rescued.has(span[0])
                    ? `${token?.text ?? span[0]} · ${span[1]}–${span[2]}ms · 정렬기가 재지 못한 낱말입니다. 두 번 누르면 확인 표시가 사라집니다`
                    : `${token?.text ?? span[0]} · ${span[1]}–${span[2]}ms`
                }
                onPointerDown={(event) => startGrab(event, row, span)}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  props.onConfirm(span[0]);
                }}
              >
                <span className="tl-word-text">{token?.text ?? span[0]}</span>
              </div>
            );
          })}
        </div>

        <div className="tl-playhead" style={{ left: `${x(currentMs)}px` }} aria-hidden="true" />
      </div>

      {unplaced.length > 0 && (
        <div className="tl-unplaced">
          <span className="tl-unplaced-label">아직 자리 없는 낱말 {unplaced.length}개 · 두 번 누르면 재생 위치에 놓입니다</span>
          <div className="tl-unplaced-row">
            {unplaced.map((token) => (
              <button
                key={token.index}
                type="button"
                className={chosen === token.index ? "chosen" : ""}
                onClick={() => props.onChoose(token.index)}
                onDoubleClick={() => props.onPlace(token.index)}
                title="두 번 눌러 앞뒤 낱말 사이 빈틈에 넣기"
              >
                {token.text}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function formatTick(ms: number, step: number): string {
  const minutes = Math.floor(ms / 60_000);
  const seconds = (ms % 60_000) / 1000;
  if (step < 1000) return `${minutes}:${seconds.toFixed(step < 100 ? 2 : 1).padStart(step < 100 ? 5 : 4, "0")}`;
  return `${minutes}:${String(Math.floor(seconds)).padStart(2, "0")}`;
}

function formatSpan(ms: number): string {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(0)}초` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}초` : `${Math.round(ms)}ms`;
}
