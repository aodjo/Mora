/**
 * Workspace — puts everything produced from a song in one place.
 *
 * Review always gets stuck on "where did this timestamp come from?". Listening to the original and
 * a stem **side by side at the same position** lets you answer that question yourself — whether
 * backing vocals are mixed into the lead, or whether the accompaniment bled through, is not
 * visible in the numbers and is known only by ear.
 *
 * That is why the playback position is shared: switching stems keeps the exact point you were
 * listening to.
 */
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { clock } from "./api";

/**
 * One artifact produced from the song, as returned by the workspace endpoint.
 *
 * `from` names the artifact this one was derived from; a null `from` marks a root, which is the
 * original. `url` is null while the artifact has not been produced yet, and such a row is shown
 * as disabled rather than hidden.
 */
interface Made {
  key: string;
  name: string;
  label: string;
  note: string;
  from: string | null;
  bytes: number | null;
  made_at: number | null;
  url: string | null;
  /** `44.1kHz · 2ch · 24bit`. Absent when the entry is the original or has not been made yet. */
  form?: string | null;
}

/** One stage the song has passed through, in pipeline order. */
interface Step {
  name: string;
  done: boolean;
  got: string;
}

/** Props for the {@link Workspace} component. */
interface Props {
  songId: number;
  /** The stem currently sounding. `origin` means the original. */
  stem: string;
  onStem: (key: string, url: string) => void;
  nowMs: number;
  totalMs: number;
  /**
   * Whether an alignment run is in progress. **The workspace must be re-read the moment it ends.**
   *
   * Reading only when the song changed left the old size and the old timestamp on screen even
   * after a stem had just been remade — which reads as "I remade it and the old one is still
   * there".
   */
  busy: boolean;
}

/**
 * Formats a byte count as a size a person can read.
 *
 * Left as raw bytes, a size does not read as large or small, so anything below 1 MiB is rendered
 * in whole KB and anything above it in MB with one decimal. An unknown size renders as an em dash.
 *
 * @param {number|null} bytes - Size in bytes, or null when unknown.
 * @returns {string} Human-readable size such as `812 KB` or `4.3 MB`, or `—` when unknown.
 */
function heft(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Formats the time an artifact was made.
 *
 * Anything made today shows the time only; anything older is prefixed with month and day, so the
 * common case stays short while older entries stay unambiguous. An unknown stamp renders as an
 * em dash.
 *
 * @param {number|null} stamp - Unix timestamp in seconds, or null when unknown.
 * @returns {string} `HH:MM` for today, `M/D HH:MM` otherwise, or `—` when unknown.
 */
function when(stamp: number | null): string {
  if (stamp === null) return "—";
  const at = new Date(stamp * 1000);
  const today = new Date();
  const sameDay = at.toDateString() === today.toDateString();
  const hh = `${at.getHours()}`.padStart(2, "0");
  const mm = `${at.getMinutes()}`.padStart(2, "0");
  return sameDay ? `${hh}:${mm}` : `${at.getMonth() + 1}/${at.getDate()} ${hh}:${mm}`;
}

/**
 * Renders the workspace panel: the stages the song has passed through and everything made from it.
 *
 * The artifact list is re-read from `/api/songs/{id}/workspace` on both `songId` and `busy`, so the
 * refetch also fires when `busy` goes from true to false — that is, the moment an alignment run
 * finishes. An in-flight response is dropped once the effect is cleaned up, so a late reply cannot
 * overwrite newer state.
 *
 * Stages are numbered because they are ordered: without the earlier stage there is no later one.
 * Each artifact row is indented under whatever it came from, with the original as the root, so the
 * derivation is visible on the left edge.
 *
 * Rows also print the sample-rate form. A stem had been left at 16 kHz mono and fed to a model that
 * expects 44.1 kHz; because the number was nowhere on screen, nobody noticed until a person said it
 * "sounded broken".
 *
 * Clicking a row swaps the sounding stem while keeping the playback position, which is the whole
 * point of the panel. Rows with no `url` are disabled.
 *
 * @param {Props} props - Component props.
 * @returns {JSX.Element} The workspace panel.
 */
export function Workspace({ songId, stem, onStem, nowMs, totalMs, busy }: Props) {
  const [files, setFiles] = useState<Made[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [failed, setFailed] = useState("");

  useEffect(() => {
    let alive = true;
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
  }, [songId, busy]);

  return (
    <div className="shop">
      <div className="shop-cols">
        <section className="shop-side">
          <h3 className="shop-head">거쳐 온 자리</h3>
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
