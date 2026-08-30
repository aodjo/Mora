// Apple Music 이 하는 것을 흉내낸다.
//
// 스크롤이 아니다. 줄마다 제자리가 있고, 지금 줄이 바뀌면 **모든 줄이 저마다 새 자리로
// 움직인다.** 브라우저의 `scrollTo({behavior:"smooth"})` 는 스프링이 없어 미끄러지듯 서고,
// 줄이 한 덩어리로 딸려 오므로 그 느낌이 안 난다.
//
// 세 가지가 그 인상을 만든다.
//
//   * **스프링** — 서는 자리에서 살짝 넘어갔다 돌아온다. 종이 뭉치가 멎는 무게가 생긴다.
//   * **층지어 늦게 출발** — 지금 줄 **아래**의 줄들이 한 줄에 0.045 초씩 늦게 떠난다.
//     한꺼번에 움직이면 판때기가 튀는데, 어긋나게 움직이면 뭉치가 자리를 잡는 것으로 읽힌다.
//     세 줄 아래부터는 더 늦추지 않는다 — 그 아래까지 늦추면 지금 줄이 이미 지나간 뒤에도
//     저 밑에서 아직 정리되고 있다.
//   * **위아래 가장자리 흐리기** — 줄이 잘려 사라지지 않고 옅어지며 나간다.
//
// 줄 높이는 재서 쓴다. Reprise 는 한 줄로 잘라 고정 높이를 쓰지만, 한국어 가사는 접히는
// 줄이 흔해서 고정 높이로는 어긋난다.

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
  /** 지금 재생 위치(ms). 보정치를 빼지 않은 오디오 시각. */
  nowMs: number;
  onSeek: (ms: number) => void;
}

/**
 * 지금 줄을 낱말로 갈라 칠한다. 찍어 둔 낱말 시각이 있을 때만.
 *
 * 줄만 켜면 여덟 초짜리 줄이 통째로 밝아진 채로 있어 어디를 부르는지 알 수 없다. 낱말이
 * 하나씩 켜져야 따라 읽힌다 — 애초에 낱말 시각을 만드는 이유가 그것이다.
 */
/** 글자든 낱말이든 하나를 칠한다. 왼쪽에서 오른쪽으로 회색이 흰색이 된다. */
function Ink({ text, at, end, nowMs }: { text: string; at: number; end: number; nowMs: number }) {
  const filled = Math.min(1, Math.max(0, (nowMs - at) / Math.max(1, end - at)));
  return (
    <span
      // 0 과 1 에서는 단색으로 칠한다. 그러데이션으로 두면 안 부른 글자의 왼쪽 끝에
      // 흰 실오라기가 남는다 — 첫 두 마디가 둘 다 0% 라 그 사이가 번진다.
      className={`word ${filled <= 0 ? "none" : filled >= 1 ? "full" : ""}`}
      // 프레임마다 바뀌므로 motion 을 끼우지 않는다. 스프링을 걸면 차오름이 소리보다
      // 뒤처지고, 그 지연이 곧 「안 맞는다」로 읽힌다.
      style={{ "--filled": `${filled * 100}%` } as React.CSSProperties}
    >
      {text}
    </span>
  );
}

function Sung({ line, offsetMs, nowMs }: { line: Line; offsetMs: number; nowMs: number }) {
  const words = line.words?.filter((word) => word && word.at != null) ?? [];
  if (!words.length) return <>{line.text}</>;
  return (
    <>
      {words.map((word, index) => (
        // 사이 공백은 스팬 밖에 둔다. inline-block 안에서는 꼬리 공백이 눌려 낱말이
        // 서로 붙어 버린다.
        <span key={index}>
          {/*
            글자 시각이 있으면 글자마다 칠한다. 한국어는 한 글자가 한 음절이라 그것이
            노래를 따라 읽는 단위다 — 「떠나보내고」가 통째로 차오르면 어디를 부르는지
            알 수 없고, 그 낱말 하나가 3 초를 차지하는 일도 흔하다.
          */}
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
 * 목소리마다의 색.
 *
 * 가라오케가 차오르는 색을 바꾼다 — 안 부른 회색은 그대로 두고 **차오른 쪽만** 갈린다.
 * 그래야 「어디까지 불렀나」와 「누가 부르나」가 서로를 가리지 않는다.
 *
 * 어두운 바탕에서 밝기가 비슷하도록 골랐다. 하나만 튀면 그 사람이 더 중요해 보인다.
 */
const VOICES = ["#f4f2ef", "#8fd8ff", "#ffc48a"];

/** 지금 줄을 창의 어디에 둘까. 한가운데에 두면 다음 줄이 접혀 안 보인다. */
const ANCHOR = 0.34;
/** 한 줄에 얼마씩 늦게 떠날까. */
const CASCADE = 0.045;
/** 몇 줄 아래까지 늦출까. */
const CASCADE_MAX = 3;
/** How long a hand-scroll holds before the view drifts back to the playing line, in ms. */
const HOLD_SCROLL = 2600;

export function Lyrics({ lines, offsetMs, anchor, singing, nowMs, onSeek }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const nodes = useRef<(HTMLButtonElement | null)[]>([]);
  const [tops, setTops] = useState<number[]>([]);
  const [height, setHeight] = useState(0);

  // 줄마다의 제자리. 재서 쌓는다 — 접히는 줄이 있어 높이가 저마다 다르다.
  useLayoutEffect(() => {
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

  // 창 크기가 바뀌면 앉는 자리도 바뀐다.
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
      {/*
        손으로 민 것은 **바깥 상자**에 건다. 줄마다의 y 에 더하면 휠을 굴릴 때마다 스프링이
        걸려 끈적인다 — 스프링은 노래를 따라가는 데 쓰는 것이지 손을 따라가는 데 쓰는 것이
        아니다. 여기서는 곧바로 움직여야 손에 붙는다.
      */}
      <div className="lyric-stage" style={{ transform: `translateY(${drift}px)` }}>
        {lines.map((line, index) => {
          const away = index - focused;
          const now = live.has(index);
          // 멀어질수록 흐리게. 세 줄 밖은 더 흐려지지 않게 묶는다 — 그 아래로는 차이가
          // 눈에 안 보이면서 브라우저만 힘들다.
          const far = Math.min(Math.abs(away), 3);
          return (
            <motion.button
              key={index}
              ref={(element) => { nodes.current[index] = element; }}
              className={`lyric ${now ? "now" : ""}`}
              // 줄을 누르면 **그 줄의 첫 글자**로 간다. 밖에서 온 줄 시각으로 가면 1 초 넘게
              // 어긋나 「눌렀는데 딴 데서 시작한다」가 된다.
              onClick={() => onSeek((line.words?.find((one) => one?.at != null)?.at ?? line.at) + offsetMs)}
              initial={false}
              animate={{
                y: (tops[index] ?? 0) - base + restAt,
                // 지금 줄은 낱말이 제 색을 칠하므로 흐리게 하지 않는다.
                opacity: now ? 1 : away < 0 ? 0.6 : 0.72 - far * 0.05,
                filter: now ? "blur(0px)" : `blur(${0.4 + far * 0.45}px)`,
                scale: now ? 1.03 : 1,
              }}
              transition={{
                y: {
                  type: "spring", duration: 0.56, bounce: 0.24,
                  // 아래 줄일수록 조금 늦게 떠난다. 위쪽은 늦추지 않는다 — 이미 지나간
                  // 줄이 꾸물거리면 눈이 그쪽으로 끌린다.
                  delay: Math.min(Math.max(away, 0), CASCADE_MAX) * CASCADE,
                },
                opacity: { duration: 0.24 },
                filter: { duration: 0.32 },
                scale: { type: "spring", duration: 0.5, bounce: 0.3 },
              }}
              // 한 요소에 style 을 두 번 주면 **뒤엣것이 앞엣것을 통째로 덮는다.** 색을
              // 따로 붙였다가 zIndex 에 지워졌다 — 타입 검사는 이걸 안 잡는다. 한 곳에 모은다.
              style={{
                zIndex: now ? 1 : 0,
                // 그 줄을 부르는 사람의 색. 낱말이 차오를 때 이 색으로 찬다.
                "--voice": VOICES[Math.min(VOICES.length - 1, Math.max(0, line.lane ?? 0))],
              } as React.CSSProperties}
              whileHover={{ opacity: 1, filter: "blur(0px)" }}
            >
              {/*
                지금 줄이 아니어도 낱말로 그린다. 평범한 글자로 바꿔 그리면 그 순간
                줄이 통째로 흰색이 되었다가 뒤늦게 흐려져, 줄이 넘어갈 때마다 희게
                번쩍인다. `nowMs` 를 -1 로 주면 모든 낱말이 안 부른 상태(회색)가 된다.
              */}
              <Sung line={line} offsetMs={offsetMs} nowMs={now ? nowMs : -1} />
              <span className="lyric-at">{clock((line.at + offsetMs) / 1000)}</span>
              {/*
                무너진 줄을 짚어 준다. 「어느 줄부터 들어야 하나」가 검수의 첫 물음인데,
                글자마다의 확신도는 이 모델에서 힘이 약해 그 물음에 답을 못 했다.
                이것은 정렬 결과 안의 모순을 보므로 음원 판이 달라도 흔들리지 않는다.
              */}
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
