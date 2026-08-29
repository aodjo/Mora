/**
 * 맞추는 동안의 자취를 터미널처럼 쌓아 보인다.
 *
 * 한 줄짜리 상태로는 모자랐다. 곡 하나에 3~5 분이 걸리는데 「보컬 뽑는 중」만 떠 있으면
 * **멈춘 것인지 더딘 것인지 알 수가 없고**, 끝난 뒤에는 무슨 일이 있었는지 아무것도 안 남는다.
 * 쌓아 두면 사람이 그 자리에서 읽고 판단한다 — 몇 초 걸렸는지, 어느 갈래를 썼는지,
 * 무너진 줄이 몇인지.
 */
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";

export interface Beat {
  /** 유닉스 시각(초). 서버가 찍는다. */
  at: number;
  text: string;
  kind: "step" | "done" | "bad";
}

interface Props {
  log: Beat[];
  /** 아직 도는 중인가. 끝났으면 마지막 줄에 커서를 안 둔다. */
  running: boolean;
  onClose: () => void;
}

/** 첫 줄로부터 몇 초 지났나. 절대 시각보다 「얼마나 걸렸나」가 읽힌다. */
function since(log: Beat[], at: number): string {
  const first = log[0]?.at ?? at;
  const gap = Math.max(0, at - first);
  return `${String(Math.floor(gap / 60)).padStart(2, "0")}:${String(Math.floor(gap % 60)).padStart(2, "0")}`;
}

export function Console({ log, running, onClose }: Props) {
  const tail = useRef<HTMLDivElement>(null);

  // 새 줄이 오면 바닥으로 따라간다. 터미널이 그렇게 움직인다.
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
        {running && <div className="tty-line"><span className="tty-at" /><span className="tty-cursor" /></div>}
      </div>
    </motion.div>
  );
}
