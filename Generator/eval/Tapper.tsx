// 낱말 시각을 사람이 손으로 넣는 자리.
//
// 한국어 낱말 정답은 어디에도 없다. LRCLIB 규격에 `words:` 가 있지만 이백 항목에 하나뿐이고
// 그 하나조차 첫 줄만 차 있다. 우리 파이프라인 출력으로 만들면 파이프라인의 실수를 정답으로
// 굳히게 된다. 그래서 손으로 만든다.
//
// 단위는 **곡 전체**다. 위에 아직 안 붙인 낱말이 순서대로 놓여 있고, 그것을 아래 타임라인의
// 제자리에 끌어다 놓는다. 놓은 뒤에는 통째로 밀거나 양끝을 당겨 다듬는다. 겹치지는 않는다.
//
// 키로도 된다 — `L` 은 지금 재생 지점에 다음 낱말을 둔다. 끌어다 놓는 것과 같은 일이므로
// 재생하며 훑을 때는 이쪽이 빠르고, 자리를 정확히 잡을 때는 끌어다 놓는 편이 낫다. 어느
// 쪽이든 길이는 0.4 초로 잡히고 그다음 양끝을 당겨 맞춘다.

import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Line, Word } from "./api";

export type { Word };

/** 낱말 하나가 차지할 수 있는 가장 짧은 길이. 이보다 좁으면 막대를 잡을 수가 없다. */
const LEAST_MS = 60;
/** 끌어다 놓았을 때 처음 잡는 길이. 곧바로 양끝을 당겨 고친다. */
const DROP_MS = 400;
/** 이 픽셀 안에 들면 착 붙는다. 확대할수록 더 짧은 시간이 된다. */
const SNAP_PX = 9;

interface Slot {
  line: number;
  word: number;
  text: string;
  at: number | null;
  end: number | null;
}

// 부를 것이 없는 표시들. 간주 자리에 이런 것이 한 줄로 들어 있는데, 그대로 두면
// 「♫」 를 낱말로 알고 찍으라고 내민다.
const NOT_A_WORD = /^[♪♫🎵🎶~\-–—…·.,()[\]{}"'“”‘’!?]+$/u;

/** 어절로 가른다. 한국어는 띄어쓰기가 곧 낱말 경계다. */
export function tokenize(text: string): string[] {
  return text.split(/\s+/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0 && !NOT_A_WORD.test(piece));
}

function flatten(lines: Line[]): Slot[] {
  const out: Slot[] = [];
  lines.forEach((line, lineIndex) => {
    tokenize(line.text).forEach((text, wordIndex) => {
      const saved = line.words?.[wordIndex];
      out.push({
        line: lineIndex, word: wordIndex, text,
        at: saved?.at ?? null, end: saved?.end ?? null,
      });
    });
  });
  return out;
}

interface Props {
  lines: Line[];
  /** 지금 재생 위치(ms). 보정치를 빼지 않은 **오디오 시각** 그대로다. */
  nowMs: number;
  /** 곡 전체의 치우침(ms). 가사 시각에 이만큼을 더하면 오디오 시각이 된다. */
  offsetMs: number;
  durationMs: number;
  playing: boolean;
  onSeek: (ms: number) => void;
  onChange: (perLine: Word[][]) => void;
  /** 줄 하나를 통째로 민다. 그 줄의 낱말은 여기서 함께 옮기고, 줄 시각만 밖으로 알린다. */
  onShiftLine: (index: number, deltaMs: number) => void;
}

export function Tapper({ lines, nowMs, offsetMs, durationMs, playing, onSeek, onChange, onShiftLine }: Props) {
  // 타임라인의 셈은 모두 **오디오 시각**으로 한다. 재생바는 실제 재생 위치이므로 치우침을
  // 보정한다고 뛰면 안 되고, 대신 가사 쪽(줄 눈금과 낱말)이 움직여야 들리는 것과 맞는다.
  // 저장은 가사 시각으로 한다 — 보정치는 곡의 성질이지 낱말의 성질이 아니다.
  const shown = (lyricMs: number) => lyricMs + offsetMs;
  const kept = (audioMs: number) => audioMs - offsetMs;
  const [slots, setSlots] = useState<Slot[]>(() => flatten(lines));
  const [zoom, setZoom] = useState(8);
  const [marks, setMarks] = useState(true);
  /** 지금 끌고 있는 낱말과 마우스 자리. */
  const [carry, setCarry] = useState<{ index: number; x: number; y: number } | null>(null);
  /** 지금 붙는 자리. 끌고 있는 동안 그 선을 밝혀 준다. */
  const [snapped, setSnapped] = useState<number | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const latest = useRef({ nowMs, slots, lines, zoom, whole: 0, durationMs, offsetMs });

  const signature = useMemo(() => lines.map((line) => line.text).join(" "), [lines]);
  useEffect(() => { setSlots(flatten(lines)); }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps


  const commit = useCallback((next: Slot[]) => {
    setSlots(next);
    const perLine: Word[][] = lines.map(() => []);
    for (const slot of next) {
      (perLine[slot.line] ??= [])[slot.word] = { text: slot.text, at: slot.at, end: slot.end };
    }
    onChange(perLine);
  }, [lines, onChange]);

  // ── 창 ────────────────────────────────────────────────────────────────
  const whole = Math.max(1000, durationMs);
  useEffect(() => { latest.current = { nowMs, slots, lines, zoom, whole, durationMs, offsetMs }; });
  const span = whole / zoom;
  const middle = zoom === 1 ? whole / 2 : nowMs;
  const from = Math.min(whole - span, Math.max(0, middle - span / 2));
  const place = (ms: number) => ((ms - from) / span) * 100;
  const timeAt = (clientX: number): number => {
    const box = track.current?.getBoundingClientRect();
    if (!box) return nowMs;
    return Math.round(from + ((clientX - box.left) / box.width) * span);
  };

  const placed = slots.map((slot, index) => ({ slot, index })).filter((one) => one.slot.at !== null);
  // 지금 울리고 있어야 할 낱말. 찍어둔 시각이 맞는지 재생하며 그대로 확인한다 —
  // 이것이 없으면 다 찍고 나서 내보낸 뒤에야 틀린 것을 안다.
  const sounding = slots.findIndex((slot) =>
    slot.at !== null && shown(slot.at) <= nowMs && nowMs < shown(slot.end ?? slot.at + DROP_MS));
  const queue = slots.map((slot, index) => ({ slot, index })).filter((one) => one.slot.at === null);
  const next = queue[0]?.index ?? -1;

  /**
   * 이 낱말이 놓일 수 있는 범위. 이웃을 넘지 못한다.
   *
   * 그릴 때의 slots 이 아니라 `latest` 를 본다 — 끄는 동안 상태가 바뀌는데 붙잡아 둔 옛
   * 목록으로 담을 세면 한 걸음 늦은 자리에서 막힌다.
   */
  const walls = useCallback((index: number): [number, number] => {
    const { slots: now, offsetMs: off } = latest.current;
    let left = 0;
    let right = Math.max(1000, latest.current.durationMs);
    for (let i = index - 1; i >= 0; i--) {
      if (now[i].at !== null) { left = (now[i].end ?? now[i].at!) + off; break; }
    }
    for (let i = index + 1; i < now.length; i++) {
      if (now[i].at !== null) { right = now[i].at! + off; break; }
    }
    return [left, right];
  }, []);

  /**
   * 가까운 자리에 착 붙인다.
   *
   * 붙일 곳은 셋이다 — 재생바, 줄이 시작하는 자리, 이미 붙인 낱말의 양끝. 손으로 몇 ms 를
   * 맞출 수는 없고, 맞추려 애쓰는 동안 정확도가 오히려 떨어진다. 화면에서 아홉 픽셀 안이면
   * 붙이는데, 확대할수록 그 아홉 픽셀이 짧은 시간이 되므로 정밀하게 놓고 싶으면 확대한다.
   */
  const magnet = useCallback((ms: number, skip: number): { at: number; to: number | null } => {
    const box = track.current?.getBoundingClientRect();
    if (!box) return { at: ms, to: null };
    const reach = (SNAP_PX / box.width) * (latest.current.whole / latest.current.zoom);
    const off = latest.current.offsetMs;
    const stops: number[] = [latest.current.nowMs];
    for (const line of latest.current.lines) stops.push(line.at + off);
    latest.current.slots.forEach((slot, i) => {
      if (i === skip || slot.at === null) return;
      stops.push(slot.at + off);
      if (slot.end != null) stops.push(slot.end + off);
    });
    let best: number | null = null;
    let gap = reach;
    for (const mark of stops) {
      const away = Math.abs(mark - ms);
      if (away <= gap) { gap = away; best = mark; }
    }
    return best === null ? { at: ms, to: null } : { at: Math.round(best), to: Math.round(best) };
  }, []);

  /** `at` 은 오디오 시각으로 받는다. 저장은 가사 시각으로 한다. */
  const put = useCallback((index: number, at: number) => {
    const off = latest.current.offsetMs;
    const [left, right] = walls(index);
    const start = Math.min(right - LEAST_MS, Math.max(left, at));
    commit(latest.current.slots.map((slot, i) =>
      (i === index
        ? { ...slot, at: start - off, end: Math.min(right, start + DROP_MS) - off }
        : slot)));
  }, [commit, walls]);

  const pull = useCallback((index: number) => {
    commit(latest.current.slots.map((slot, i) => (i === index ? { ...slot, at: null, end: null } : slot)));
  }, [commit]);

  /**
   * 줄 시각을 바탕으로 낱말을 미리 깔아 둔다.
   *
   * 백 개 가까운 낱말을 맨바닥에서 하나씩 놓을 수는 없다. 줄이 언제 시작하고 끝나는지는
   * 이미 알고 있으므로, 그 사이를 **글자 수만큼** 나눠 놓고 사람은 틀린 것만 고친다.
   * 한국어는 한 글자가 대체로 한 음절이라 글자 수가 길이의 그럴듯한 대리값이다.
   *
   * 줄의 끝을 모르면(바이브는 시작만 준다) 다음 줄의 시작까지로 본다. 마지막 줄만 4 초로
   * 둔다 — 곡의 끝까지 늘리면 여운 위에 낱말이 깔린다.
   */
  const spread = useCallback((onlyEmpty: boolean) => {
    const now = latest.current.slots;
    const next = [...now];
    latest.current.lines.forEach((line, lineIndex) => {
      const mine = now.map((slot, i) => ({ slot, i })).filter((one) => one.slot.line === lineIndex);
      if (!mine.length) return;
      if (onlyEmpty && mine.some((one) => one.slot.at !== null)) return;
      const after = latest.current.lines[lineIndex + 1];
      const until = line.end ?? after?.at ?? line.at + 4000;
      const room = Math.max(mine.length * LEAST_MS, until - line.at);
      const weights = mine.map((one) => Math.max(1, one.slot.text.length));
      const total = weights.reduce((sum, one) => sum + one, 0);
      let at = line.at;
      mine.forEach((one, order) => {
        const width = Math.max(LEAST_MS, Math.round((weights[order] / total) * room));
        next[one.i] = { ...one.slot, at: Math.round(at), end: Math.round(at + width) };
        at += width;
      });
    });
    commit(next);
  }, [commit]);

  // 아직 한 번도 안 깐 곡이면 열자마자 깔아 둔다. 빈 타임라인을 마주하고 백 개를 하나씩
  // 놓기 시작할 사람은 없다. (spread 보다 먼저 두면 의존성 배열이 그릴 때 평가되어
  // 아직 만들어지지 않은 것을 집는다 — TDZ.)
  const seeded = useRef("");
  useEffect(() => {
    if (seeded.current === signature || !slots.length) return;
    seeded.current = signature;
    if (slots.every((slot) => slot.at === null)) spread(true);
  }, [signature, slots, spread]);

  // ── 끌어다 놓기 ───────────────────────────────────────────────────────
  const grab = (index: number) => (event: React.PointerEvent) => {
    event.preventDefault();
    setCarry({ index, x: event.clientX, y: event.clientY });
    const over = (moved: PointerEvent) => {
      const box = track.current?.getBoundingClientRect();
      return !!box && moved.clientX >= box.left && moved.clientX <= box.right
        && moved.clientY >= box.top && moved.clientY <= box.bottom;
    };
    const move = (moved: PointerEvent) => {
      setCarry({ index, x: moved.clientX, y: moved.clientY });
      setSnapped(over(moved) ? magnet(timeAt(moved.clientX), index).to : null);
    };
    const drop = (ended: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", drop);
      setCarry(null);
      setSnapped(null);
      // 타임라인 위에서 손을 놓았을 때만 붙인다. 그 밖이면 없던 일이다.
      if (over(ended)) put(index, magnet(timeAt(ended.clientX), index).at);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", drop);
  };

  /**
   * 줄 눈금을 끈다. 그 줄의 낱말이 통째로 따라온다.
   *
   * 치우침 보정은 곡 전체를 한꺼번에 미는 것이라 한두 줄만 어긋난 곡에는 쓸 수가 없다.
   * LRCLIB 도 바이브도 사람이 찍은 것이라 그런 줄이 섞인다.
   */
  const dragLine = (index: number) => (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const startAt = shown(lines[index].at);
    const grabbed = timeAt(event.clientX);
    // 앞뒤 줄을 넘지 못한다. 순서가 뒤집힌 가사는 정답이 될 수 없다.
    const left = index > 0 ? shown(lines[index - 1].at) + LEAST_MS : 0;
    const right = index + 1 < lines.length ? shown(lines[index + 1].at) - LEAST_MS : whole;

    let last = startAt;
    const move = (moved: PointerEvent) => {
      const hit = magnet(startAt + (timeAt(moved.clientX) - grabbed), -1);
      setSnapped(hit.to);
      const at = Math.min(right, Math.max(left, hit.at));
      const step = Math.round(at - last);
      if (step === 0) return;
      last = at;
      onShiftLine(index, step);
      commit(latest.current.slots.map((slot) =>
        (slot.line === index && slot.at !== null
          ? { ...slot, at: slot.at + step, end: slot.end == null ? slot.end : slot.end + step }
          : slot)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setSnapped(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** 이미 붙인 막대를 밀거나 양끝을 당긴다. 위로 빼내면 뗀다. */
  const shift = (index: number, edge: "at" | "end" | "both") => (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const startAt = shown(slots[index].at!);
    const startEnd = shown(slots[index].end ?? slots[index].at! + DROP_MS);
    const grabbed = timeAt(event.clientX);
    const [left, right] = walls(index);

    const move = (moved: PointerEvent) => {
      const raw = timeAt(moved.clientX);
      if (edge === "both") {
        const width = startEnd - startAt;
        // 통째로 밀 때는 **앞끝**이 붙는다. 잡은 자리가 아니라 앞끝이 기준이라야
        // 재생바에 대면 그 순간부터 시작하는 것으로 읽힌다.
        const wanted = startAt + (raw - grabbed);
        const hit = magnet(wanted, index);
        setSnapped(hit.to);
        const at = Math.min(right - width, Math.max(left, hit.at));
        commit(latest.current.slots.map((slot, i) =>
          (i === index ? { ...slot, at: kept(Math.round(at)), end: kept(Math.round(at + width)) } : slot)));
      } else if (edge === "at") {
        const hit = magnet(raw, index);
        setSnapped(hit.to);
        const at = Math.min(startEnd - LEAST_MS, Math.max(left, hit.at));
        commit(latest.current.slots.map((slot, i) =>
          (i === index ? { ...slot, at: kept(at), end: kept(startEnd) } : slot)));
      } else {
        const hit = magnet(raw, index);
        setSnapped(hit.to);
        const end = Math.min(right, Math.max(startAt + LEAST_MS, hit.at));
        commit(latest.current.slots.map((slot, i) =>
          (i === index ? { ...slot, at: kept(startAt), end: kept(end) } : slot)));
      }
    };
    const up = (ended: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setSnapped(null);
      const box = track.current?.getBoundingClientRect();
      // 타임라인 밖으로 끌어내면 뗀다 — 다시 목록으로 돌아간다.
      if (edge === "both" && box && (ended.clientY < box.top - 20 || ended.clientY > box.bottom + 20)) {
        pull(index);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ── 키 ────────────────────────────────────────────────────────────────
  /** `L` 은 지금 재생 지점에 다음 낱말을 둔다 — 끌어다 놓는 것과 같은 일을 손 안 대고 한다. */
  const drop = useCallback(() => {
    const { nowMs: at, slots: current } = latest.current;
    const index = current.findIndex((slot) => slot.at === null);
    if (index === -1) return;
    put(index, Math.round(at));
  }, [put]);

  const undo = useCallback(() => {
    const { slots: current } = latest.current;
    const last = current.map((slot, i) => ({ slot, i })).filter((one) => one.slot.at !== null).pop();
    if (!last) return;
    commit(current.map((slot, i) => (i === last.i ? { ...slot, at: null, end: null } : slot)));
    onSeek(last.slot.at! + latest.current.offsetMs);
  }, [commit, onSeek]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      const hit = event.key.toLowerCase();
      // repeat 를 막지 않으면 누르고 있는 동안 낱말이 우수수 떨어진다.
      if (hit === "l") { event.preventDefault(); if (!event.repeat) drop(); }
      else if (hit === "k") { event.preventDefault(); undo(); }
      else if (hit === "j") { event.preventDefault(); onSeek(Math.max(0, latest.current.nowMs - 2000)); }
      // 스페이스는 App 이 두 화면 모두에 대해 잡는다. 여기서 또 잡으면 두 번 눌린다.
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [drop, undo, onSeek]);

  const atLine = slots[next === -1 ? slots.length - 1 : next]?.line ?? 0;

  return (
    <div className="tap">
      <div className="tap-head">
        <span className="tap-count">붙인 낱말 <b>{placed.length}</b> / {slots.length}</span>
        <span className="tap-line-at">{atLine + 1}번째 줄 / {lines.length}</span>
        <span className="tap-keys">
          막대를 끌어 고치기 · <kbd>L</kbd> 재생 지점에 두기 · <kbd>K</kbd> 되돌리기 · <kbd>J</kbd> 2초 뒤로 · <kbd>Space</kbd> 재생 · <kbd>←→</kbd> 5초
        </span>
        <button className="tap-fill" onClick={() => spread(false)}>모두 다시 깔기</button>
        <button className="tap-clear" onClick={() => commit(slots.map((s) => ({ ...s, at: null, end: null })))}>
          모두 지우기
        </button>
      </div>

      {/* 가사. 아직 안 붙인 낱말이 여기서 그대로 집힌다. */}
      <div className="tap-sheet">
        {/* 줄의 글은 낱말로 그린다. 간주만 있는 줄은 낱말이 없어 통째로 빠진다. */}
        {lines.map((_line, lineIndex) => {
          const mine = slots.map((slot, index) => ({ slot, index })).filter((one) => one.slot.line === lineIndex);
          if (!mine.length) return null;
          return (
            <div key={lineIndex} className={`sheet-line ${lineIndex === atLine ? "now" : ""}`}>
              <span className="sheet-no">{lineIndex + 1}</span>
              <span className="sheet-words">
                {mine.map(({ slot, index }) => (
                  <motion.button
                    key={index}
                    className={`tok ${slot.at !== null ? "set" : ""} ${index === next ? "here" : ""} ${carry?.index === index ? "lifted" : ""} ${index === sounding ? "live" : ""}`}
                    onPointerDown={slot.at === null ? grab(index) : undefined}
                    onClick={() => { if (slot.at !== null) onSeek(shown(slot.at)); }}
                    animate={{
                      scale: index === sounding ? 1.14 : index === next ? 1.05 : 1,
                      y: index === sounding ? -3 : 0,
                    }}
                    transition={{ type: "spring", duration: 0.34, bounce: 0.42 }}
                  >
                    <span className="tok-text">{slot.text}</span>
                    {slot.at !== null && (
                      <span className="tok-at">{(shown(slot.at) / 1000).toFixed(2)}s</span>
                    )}
                    {/* 재생 중에는 다음에 붙일 낱말이 숨쉰다 — 어디를 볼지 알려 준다. */}
                    {index === next && playing && (
                      <motion.span className="tok-wait"
                        animate={{ opacity: [0.3, 0.85, 0.3] }}
                        transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }} />
                    )}
                  </motion.button>
                ))}
              </span>
            </div>
          );
        })}
      </div>

      <div className="bars-wrap">
        <div className="bars-tools">
          <span>{(span / 1000).toFixed(1)}초 구간</span>
          <button onClick={() => setZoom((z) => Math.max(1, z / 2))} disabled={zoom <= 1}>−</button>
          <span className="bars-zoom">{zoom}×</span>
          <button onClick={() => setZoom((z) => Math.min(64, z * 2))} disabled={zoom >= 64}>＋</button>
          <button onClick={() => setZoom(1)} disabled={zoom === 1}>곡 전체</button>
          {/* 줄 눈금은 낱말을 깔고 나면 할 일을 다 한다. 끌 수 있게 둔다. */}
          <button className={marks ? "on" : ""} onClick={() => setMarks((on) => !on)}>줄 눈금</button>
          <span className="bars-hint">막대를 끌면 통째로 · 양끝을 끌면 앞뒤 · 재생바에 대면 착 붙는다 · 밖으로 빼면 뗀다 · 휠로 확대</span>
        </div>
        <div
          ref={track}
          className={`bars ${carry ? "catching" : ""}`}
          onWheel={(event) => {
            if (Math.abs(event.deltaY) < 1) return;
            event.preventDefault();
            setZoom((z) => Math.min(64, Math.max(1, event.deltaY < 0 ? z * 2 : z / 2)));
          }}
          onClick={(event) => onSeek(timeAt(event.clientX))}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((share) => (
            <span key={share} className="bars-tick" style={{ left: `${share * 100}%` }}>
              <i />{((from + share * span) / 1000).toFixed(2)}s
            </span>
          ))}
          {marks && lines.map((line, index) => {
            const left = place(shown(line.at));
            if (left < -1 || left > 101) return null;
            return (
              <span
                key={`l${index}`} className="bars-line" style={{ left: `${left}%` }}
                title={`${index + 1}번째 줄 · ${(shown(line.at) / 1000).toFixed(2)}s — 끌어서 옮기기`}
                onPointerDown={dragLine(index)}
                onClick={(event) => event.stopPropagation()}
              >
                <b>{index + 1}</b>
              </span>
            );
          })}
          {placed.map(({ slot, index }) => {
            const end = shown(slot.end ?? slot.at! + DROP_MS);
            const left = place(shown(slot.at!));
            const width = place(end) - left;
            if (left > 102 || left + width < -2) return null;
            return (
              <div
                key={index} className={`bar ${index === next ? "here" : ""} ${index === sounding ? "live" : ""}`}
                style={{ left: `${left}%`, width: `${Math.max(0.4, width)}%` }}
                title={`${slot.text} · ${(shown(slot.at!) / 1000).toFixed(2)}s ~ ${(end / 1000).toFixed(2)}s`}
                onPointerDown={shift(index, "both")}
                onClick={(event) => event.stopPropagation()}
              >
                <span className="bar-grip left" onPointerDown={shift(index, "at")} />
                <span className="bar-text">{slot.text}</span>
                <span className="bar-grip right" onPointerDown={shift(index, "end")} />
              </div>
            );
          })}
          {/* 붙는 자리. 끌고 있는 동안만 보인다. */}
          {snapped !== null && (
            <motion.span className="bars-snap" style={{ left: `${place(snapped)}%` }}
              initial={{ opacity: 0, scaleY: 0.6 }} animate={{ opacity: 1, scaleY: 1 }}
              transition={{ duration: 0.12 }} />
          )}
          <div className={`bars-now ${snapped !== null && Math.abs(snapped - nowMs) < 1 ? "held" : ""}`}
            style={{ left: `${Math.min(100, Math.max(0, place(nowMs)))}%` }} />
          {placed.length === 0 && !carry && (
            <span className="bars-empty-hint">위의 낱말을 여기로 끌어다 놓으세요</span>
          )}
        </div>
      </div>

      {/* 끌고 다니는 동안 손끝을 따라다니는 것 */}
      {carry && (
        <div className="carry" style={{ left: carry.x, top: carry.y }}>
          {slots[carry.index].text}
        </div>
      )}
    </div>
  );
}
