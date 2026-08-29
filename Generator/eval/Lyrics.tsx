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
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Line } from "./api";
import { clock } from "./api";

interface Props {
  lines: Line[];
  offsetMs: number;
  activeIndex: number;
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
function Sung({ line, offsetMs, nowMs }: { line: Line; offsetMs: number; nowMs: number }) {
  const words = line.words?.filter((word) => word && word.at != null) ?? [];
  if (!words.length) return <>{line.text}</>;
  return (
    <>
      {words.map((word, index) => {
        const at = word.at! + offsetMs;
        const end = (word.end ?? word.at! + 400) + offsetMs;
        // 낱말 안에서 얼마나 왔나. 이 값이 흰색이 차오른 자리다.
        const filled = Math.min(1, Math.max(0, (nowMs - at) / Math.max(1, end - at)));
        return (
          // 사이 공백은 스팬 밖에 둔다. inline-block 안에서는 꼬리 공백이 눌려 낱말이
          // 서로 붙어 버린다.
          <span key={index}>
            <span
              className="word"
              // 프레임마다 바뀌므로 motion 을 끼우지 않는다. 스프링을 걸면 차오름이
              // 소리보다 뒤처지고, 그 지연이 곧 「안 맞는다」로 읽힌다.
              style={{ "--filled": `${filled * 100}%` } as React.CSSProperties}
            >
              {word.text}
            </span>
            {index < words.length - 1 ? " " : ""}
          </span>
        );
      })}
    </>
  );
}

/** 지금 줄을 창의 어디에 둘까. 한가운데에 두면 다음 줄이 접혀 안 보인다. */
const ANCHOR = 0.34;
/** 한 줄에 얼마씩 늦게 떠날까. */
const CASCADE = 0.045;
/** 몇 줄 아래까지 늦출까. */
const CASCADE_MAX = 3;

export function Lyrics({ lines, offsetMs, activeIndex, nowMs, onSeek }: Props) {
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

  const focused = Math.max(0, activeIndex);
  const anchor = height * ANCHOR;
  const base = tops[focused] ?? 0;

  return (
    <div className="lyric-wrap" ref={box}>
      <div className="lyric-stage">
        {lines.map((line, index) => {
          const away = index - focused;
          const now = away === 0;
          // 멀어질수록 흐리게. 세 줄 밖은 더 흐려지지 않게 묶는다 — 그 아래로는 차이가
          // 눈에 안 보이면서 브라우저만 힘들다.
          const far = Math.min(Math.abs(away), 3);
          return (
            <motion.button
              key={index}
              ref={(element) => { nodes.current[index] = element; }}
              className={`lyric ${now ? "now" : ""}`}
              onClick={() => onSeek(line.at + offsetMs)}
              initial={false}
              animate={{
                y: (tops[index] ?? 0) - base + anchor,
                // 지금 줄은 낱말이 제 색을 칠하므로 흐리게 하지 않는다.
                opacity: now ? 1 : away < 0 ? 0.3 : 0.42 - far * 0.03,
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
              style={{ zIndex: now ? 1 : 0 }}
              whileHover={{ opacity: 1, filter: "blur(0px)" }}
            >
              {now
                ? <Sung line={line} offsetMs={offsetMs} nowMs={nowMs} />
                : line.text}
              <span className="lyric-at">{clock((line.at + offsetMs) / 1000)}</span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
