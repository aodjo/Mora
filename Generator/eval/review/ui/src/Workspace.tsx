/**
 * 작업실 — 그 곡을 다루며 만들어 낸 것들을 한자리에 놓는다.
 *
 * 검수하다 「이 시각이 어디서 나온 거지」에서 늘 막힌다. 원본과 갈래를 **나란히 같은 자리에서**
 * 들어 보면 그 물음에 스스로 답할 수 있다 — 백보컬이 리드에 섞여 있는지, 반주가 새어 들었는지는
 * 숫자로는 안 보이고 귀로만 안다.
 *
 * 그래서 재생 자리를 공유한다. 갈래를 바꿔도 듣던 지점이 그대로다.
 */
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { clock } from "./api";

interface Made {
  key: string;
  name: string;
  label: string;
  note: string;
  from: string | null;
  bytes: number | null;
  made_at: number | null;
  url: string | null;
  /** `44.1kHz · 2ch · 24bit`. 없으면 원본이거나 아직 안 만든 것. */
  form?: string | null;
}

interface Step {
  name: string;
  done: boolean;
  got: string;
}

interface Props {
  songId: number;
  /** 지금 울리고 있는 갈래. `origin` 이면 원본. */
  stem: string;
  onStem: (key: string, url: string) => void;
  nowMs: number;
  totalMs: number;
}

/** 사람이 읽는 크기. 바이트 그대로 두면 큰지 작은지 안 읽힌다. */
function heft(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 언제 만들었나. 오늘 것은 시각만, 지난 것은 날짜까지. */
function when(stamp: number | null): string {
  if (stamp === null) return "—";
  const at = new Date(stamp * 1000);
  const today = new Date();
  const sameDay = at.toDateString() === today.toDateString();
  const hh = `${at.getHours()}`.padStart(2, "0");
  const mm = `${at.getMinutes()}`.padStart(2, "0");
  return sameDay ? `${hh}:${mm}` : `${at.getMonth() + 1}/${at.getDate()} ${hh}:${mm}`;
}

export function Workspace({ songId, stem, onStem, nowMs, totalMs }: Props) {
  const [files, setFiles] = useState<Made[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [failed, setFailed] = useState("");

  useEffect(() => {
    let alive = true;
    setFiles([]);
    setSteps([]);
    setFailed("");
    fetch(`/api/songs/${songId}/workspace`)
      .then((got) => (got.ok ? got.json() : Promise.reject(new Error(`HTTP ${got.status}`))))
      .then((got) => {
        if (!alive) return;
        setFiles(got.files);
        setSteps(got.steps);
      })
      .catch((error) => alive && setFailed(String(error.message ?? error)));
    return () => { alive = false; };
  }, [songId]);

  return (
    <div className="shop">
      <div className="shop-cols">
        <section className="shop-side">
          <h3 className="shop-head">거쳐 온 자리</h3>
          {/* 단계는 차례가 있으므로 번호를 매긴다 — 앞 단계가 없으면 뒤가 없다. */}
          <ol className="steps">
            {steps.map((one, at) => (
              <li key={one.name} className={`step ${one.done ? "done" : ""}`}>
                <span className="step-no">{at + 1}</span>
                <span className="step-body">
                  <b>{one.name}</b>
                  <i>{one.got}</i>
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section className="shop-main">
          <h3 className="shop-head">
            만들어진 것
            <span className="shop-hint">누르면 그 소리로 바꿔 듣는다 · 자리는 그대로</span>
          </h3>
          {failed && <p className="shop-fail">못 읽음: {failed}</p>}
          <ul className="made">
            {files.map((one) => {
              const here = stem === one.key;
              return (
                <li key={one.key}>
                  <motion.button
                    className={`made-row ${here ? "on" : ""} ${one.url ? "" : "missing"}`}
                    disabled={!one.url}
                    onClick={() => one.url && onStem(one.key, one.url)}
                    animate={{ scale: here ? 1.008 : 1 }}
                    transition={{ type: "spring", duration: 0.34, bounce: 0.3 }}
                  >
                    {/* 무엇에서 나왔는지 왼쪽에 들여쓰기로 보인다 — 원본이 뿌리다. */}
                    <span className={`made-tree ${one.from ? "child" : ""}`}>
                      {one.from ? "└" : "●"}
                    </span>
                    <span className="made-body">
                      <b>
                        {one.label}
                        {here && <span className="made-live">듣는 중</span>}
                        {!one.url && <span className="made-none">아직 없음</span>}
                      </b>
                      <i>{one.note}</i>
                      <code>
                        {one.name}
                        {/* 표본율을 내보인다. 갈래를 16 kHz 홑소리로 남겨 두고 44.1 kHz 를
                            바라는 모델에 넣고 있었는데, 숫자가 안 보여서 사람이 「깨진다」고
                            말해 줄 때까지 몰랐다. */}
                        {one.form && <em>{one.form}</em>}
                      </code>
                    </span>
                    <span className="made-facts">
                      <span>{heft(one.bytes)}</span>
                      <span>{when(one.made_at)}</span>
                    </span>
                  </motion.button>
                </li>
              );
            })}
          </ul>
          <p className="shop-foot">
            지금 {clock(nowMs / 1000)} / {clock(totalMs / 1000)} 지점 ·
            아래 재생 단추가 고른 갈래를 그대로 울린다
          </p>
        </section>
      </div>
    </div>
  );
}
