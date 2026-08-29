// 곡을 넣는 자리. 한 곡을 만들려면 두 가지가 필요하다 — 가사(LRCLIB)와 음원(유튜브).
//
// 통합에서는 둘을 나란히 놓고 하나씩 고른다. 길이가 얼마나 어긋나는지 그 자리에서 보이므로
// 라이브·리메이크를 집어내기 쉽다. 한쪽만 필요할 때는(음원만 바꾸기) 개별로 연다.

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioHit, LyricHit, LyricSource } from "./api";
import { clock, findAudio, findLyrics } from "./api";

export type Mode = "both" | "lyrics" | "audio";

interface Props {
  mode: Mode;
  seedArtist?: string;
  seedTitle?: string;
  /** 음원만 바꿀 때, 길이를 견줄 기준. */
  wantSeconds?: number;
  onClose: () => void;
  onPick: (picked: { lyric?: LyricHit; audio?: AudioHit }) => void;
}

export function Finder({ mode: initial, seedArtist, seedTitle, wantSeconds, onClose, onPick }: Props) {
  const [mode, setMode] = useState<Mode>(initial);
  // 한국 곡은 바이브를 먼저 본다. LRCLIB 은 마흔 곡 중 다섯 곡만 쓸 만했다.
  const [source, setSource] = useState<LyricSource>("vibe");
  const [artist, setArtist] = useState(seedArtist ?? "");
  const [title, setTitle] = useState(seedTitle ?? "");
  const [lyrics, setLyrics] = useState<LyricHit[] | null>(null);
  const [audios, setAudios] = useState<AudioHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pickedLyric, setPickedLyric] = useState<number | null>(null);
  const [pickedAudio, setPickedAudio] = useState<number | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const run = useCallback(async () => {
    const free = [artist, title].filter(Boolean).join(" ").trim();
    if (!free) { setLyrics(null); setAudios(null); return; }
    setBusy(true); setError("");
    try {
      // 둘을 함께 쏜다. 하나가 늦다고 다른 하나를 기다릴 이유가 없다.
      const [got1, got2] = await Promise.allSettled([
        mode === "audio" ? Promise.resolve([]) : findLyrics(source, { artist, title }),
        mode === "lyrics" ? Promise.resolve([]) : findAudio(free),
      ]);
      setLyrics(got1.status === "fulfilled" ? (got1.value as LyricHit[]) : []);
      setAudios(got2.status === "fulfilled" ? (got2.value as AudioHit[]) : []);
      const failed = [got1, got2].find((g) => g.status === "rejected");
      if (failed && failed.status === "rejected") setError(String(failed.reason?.message ?? failed.reason));
    } finally {
      setBusy(false);
    }
  }, [artist, title, mode, source]);

  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(run, 420);
    return () => window.clearTimeout(timer.current);
  }, [run]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const lyric = pickedLyric === null ? undefined : lyrics?.[pickedLyric];
  const audio = pickedAudio === null ? undefined : audios?.[pickedAudio];
  // 견줄 기준: 음원만 바꿀 때는 원래 곡 길이, 새로 넣을 때는 고른 가사의 길이.
  const reference = wantSeconds ?? lyric?.duration;
  const ready = mode === "audio" ? !!audio : mode === "lyrics" ? !!lyric : !!lyric && !!audio;

  return (
    <motion.div
      className="veil" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.22 }}
    >
      <motion.div
        className="sheet"
        initial={{ y: 18, scale: 0.985, opacity: 0 }}
        animate={{ y: 0, scale: 1, opacity: 1 }}
        exit={{ y: 10, scale: 0.99, opacity: 0 }}
        transition={{ type: "spring", stiffness: 320, damping: 30, mass: 0.8 }}
      >
        <div className="sheet-head">
          <h2>곡 넣기</h2>
          <div className="modes">
            {([["both", "통합"], ["lyrics", "가사만"], ["audio", "음원만"]] as const).map(([key, label]) => (
              <button key={key} className={`mode ${mode === key ? "on" : ""}`} onClick={() => setMode(key)}>
                {label}
              </button>
            ))}
          </div>
          <div className="fields">
            <input placeholder="아티스트" value={artist} onChange={(event) => setArtist(event.target.value)} autoFocus />
            <input placeholder="제목" value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>
        </div>

        <div className={`panes ${mode === "both" ? "" : "one"}`}>
          {mode !== "audio" && (
            <div className="pane">
              <div className="pane-top pane-top-row">
                <span>가사</span>
                <span className="src">
                  {([["vibe", "바이브"], ["lrclib", "LRCLIB"]] as const).map(([key, label]) => (
                    <button key={key} className={`src-one ${source === key ? "on" : ""}`}
                      onClick={() => setSource(key)}>{label}</button>
                  ))}
                </span>
              </div>
              <div className="pane-list">
                <Hits
                  busy={busy} rows={lyrics}
                  render={(hit: LyricHit, index) => {
                    const gap = reference ? Math.abs(hit.duration - reference) : null;
                    return (
                      <Hit
                        key={index} on={pickedLyric === index} onClick={() => setPickedLyric(index)}
                        name={hit.title}
                        sub={[hit.artist, hit.album].filter(Boolean).join(" · ")}
                        right={<>
                          {hit.lines.length}줄<br />{clock(hit.duration)}
                          {hit.instrumental && <><br /><span className="hit-tag warn">반주</span></>}
                        </>}
                        note={gap !== null && mode === "both" && pickedAudio !== null
                          ? `${gap.toFixed(0)}초 차이` : undefined}
                      />
                    );
                  }}
                />
              </div>
            </div>
          )}

          {mode !== "lyrics" && (
            <div className="pane">
              <div className="pane-top">음원 · 유튜브</div>
              <div className="pane-list">
                <Hits
                  busy={busy} rows={audios}
                  render={(hit: AudioHit, index) => {
                    const gap = reference ? Math.abs(hit.duration - reference) : null;
                    return (
                      <Hit
                        key={index} on={pickedAudio === index} onClick={() => setPickedAudio(index)}
                        name={hit.title} sub={hit.uploader}
                        right={<>
                          {clock(hit.duration)}
                          {gap !== null && <><br />
                            <span className={`hit-tag ${gap <= 3 ? "good" : gap <= 8 ? "" : "warn"}`}>
                              {gap.toFixed(0)}초
                            </span></>}
                        </>}
                      />
                    );
                  }}
                />
              </div>
            </div>
          )}
        </div>

        <div className="sheet-foot">
          <div className="picked">
            {error && <span className="picked-bad">못 찾음: {error}</span>}
            {!error && mode !== "audio" && (
              <span className={`picked-one ${lyric ? "set" : ""}`}>
                <span className="picked-tag">가사</span>
                {lyric ? `${lyric.artist} — ${lyric.title} · ${lyric.lines.length}줄` : "고르지 않음"}
              </span>
            )}
            {!error && mode !== "lyrics" && (
              <span className={`picked-one ${audio ? "set" : ""}`}>
                <span className="picked-tag">음원</span>
                {audio
                  ? `${audio.title.slice(0, 40)} · ${clock(audio.duration)}` +
                    (reference ? ` · ${Math.abs(audio.duration - reference).toFixed(0)}초 차이` : "")
                  : "고르지 않음"}
              </span>
            )}
          </div>
          <button className="go" disabled={!ready} onClick={() => onPick({ lyric, audio })}>
            {mode === "audio" ? "바꾸기" : "넣기"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function Hits<T>({ busy, rows, render }: {
  busy: boolean; rows: T[] | null; render: (row: T, index: number) => React.ReactNode;
}) {
  if (busy && !rows) return <div className="pane-empty"><span className="spin" /> 찾는 중</div>;
  if (!rows) return <div className="pane-empty">검색어를 넣으세요</div>;
  if (!rows.length) return <div className="pane-empty">없음</div>;
  return <AnimatePresence initial={false}>{rows.map(render)}</AnimatePresence>;
}

function Hit({ on, onClick, name, sub, right, note }: {
  on: boolean; onClick: () => void; name: string; sub: string;
  right: React.ReactNode; note?: string;
}) {
  return (
    <motion.button
      className={`hit ${on ? "on" : ""}`} onClick={onClick}
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      whileHover={{ backgroundColor: "rgba(255,255,255,0.06)" }}
    >
      <motion.span className="hit-check" animate={{ scale: on ? 1 : 0.4, opacity: on ? 1 : 0 }}
        transition={{ type: "spring", stiffness: 520, damping: 26 }}>✓</motion.span>
      <div className="hit-main">
        <div className="hit-name">{name}</div>
        <div className="hit-sub">{sub}{note ? ` · ${note}` : ""}</div>
      </div>
      <div className="hit-right">{right}</div>
    </motion.button>
  );
}
