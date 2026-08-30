/**
 * 모델이 놓은 자리를 **눈으로 훑는** 화면. 고치는 기능은 없다.
 *
 * 앞판(`Tapper`)은 사람이 낱말을 하나씩 끌어다 놓는 곳이었다. 그 일이 없어졌다 — 정확히
 * 내놓는 것은 모델의 몫이고 사람은 듣고 판정만 한다. 손으로 고칠 수 있게 두면 **모델의
 * 실수가 사람 손을 거쳐 정답으로 굳는다.**
 *
 * 그래서 700 줄짜리를 손보는 대신 새로 짰다. 끌기·놓기·키 입력·붙이기·되돌리기가 서로
 * 얽혀 있어 「고치는 부분만 떼기」가 「다시 짜기」보다 어렵다.
 */
import { motion } from "motion/react";
import { useMemo, useRef, useState } from "react";
import type { Line } from "./api";
import { clock } from "./api";

/** 목소리마다의 칸. 듣기 화면의 색과 짝이 맞아야 두 화면이 한 곡으로 읽힌다. */
const LANE_NAMES = ["메인", "두 번째 목소리", "세 번째"];
const LANE_H = 38;
/** 눈금과 줄 번호가 앉는 자리. 막대는 그 아래부터 시작한다. */
const RULER_H = 20;

interface Bar {
  text: string;
  at: number;
  end: number;
  lane: number;
  line: number;
  shaky: boolean;
}

interface Props {
  lines: Line[];
  /** 지금 재생 위치(ms). 보정치를 빼지 않은 **오디오 시각** 그대로다. */
  nowMs: number;
  /** 곡 전체의 치우침(ms). 가사 시각에 이만큼을 더하면 오디오 시각이 된다. */
  offsetMs: number;
  durationMs: number;
  onSeek: (ms: number) => void;
}

export function Timeline({ lines, nowMs, offsetMs, durationMs, onSeek }: Props) {
  const [zoom, setZoom] = useState(8);
  const track = useRef<HTMLDivElement>(null);

  // 글자를 한 줄로 편다. 그리는 데만 쓰므로 원본을 안 건드린다.
  const bars = useMemo<Bar[]>(() => {
    const out: Bar[] = [];
    lines.forEach((line, index) => {
      const lane = Math.min(LANE_NAMES.length - 1, Math.max(0, line.lane ?? 0));
      for (const word of line.words ?? []) {
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
  const place = (ms: number) => ((ms - from) / span) * 100;

  // 지금 울리고 있는 글자. 찍어 둔 시각이 맞는지 재생하며 그대로 확인한다.
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

          {/* 줄이 시작하는 자리. 어느 대목인지 짚어 준다. */}
          {lines.map((line, index) => {
            const first = line.words?.find((one) => one?.at != null)?.at;
            if (first == null) return null;
            const left = place(first + offsetMs);
            if (left < -1 || left > 101) return null;
            return (
              <span key={`l${index}`} className="bars-line read" style={{ left: `${left}%` }}
                title={`${index + 1}번째 줄 · ${line.text.slice(0, 30)}`}>
                <b>{index + 1}</b>
              </span>
            );
          })}

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
                <span className="bar-text">{one.text}</span>
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
