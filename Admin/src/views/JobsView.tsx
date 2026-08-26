import { Ban, LoaderCircle, RotateCcw } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { api } from "../api";
import { useToast } from "../Toast";
import { number, relativeTime, stageLabel, stateLabel, stateTone, text, type AdminItem } from "./utils";

type JobFilter = "all" | "active" | "failed" | "done";
/** 더 진행되지 않는 상태들 — 여기서는 사람이 다시 시작할 수 있어야 한다. */
const DONE_STATES = ["failed", "unsupported_language", "candidate_ready", "cancelled"];

/**
 * 재시도로 대기열에 돌아간 작업은 state 가 queued 다 — 실패한 적이 없는 새 작업과 같은 값이다.
 * 상태만 보고 나누면 그 둘이 한 칸에 들어가고, 화면에는 "할당 대기" 로만 보인다. 실제로 그런
 * 일이 있었다: 118번 연속으로 실패하는 동안 '실패' 탭은 0 이었고, 아무도 여섯 시간을 몰랐다.
 * 마지막 시도가 남긴 error_code 가 그 차이를 알고 있으니, 그것까지 보고 나눈다.
 */
function stumbled(item: AdminItem): boolean {
  const state = text(item.state, "");
  if (["failed", "unsupported_language"].includes(state)) return true;
  // 지금 누가 붙들고 있는 작업의 옛 오류는 아직 실패가 아니다.
  return text(item.error_code, "") !== "" && !["claimed", "running"].includes(state);
}

const filters: Array<[JobFilter, string, (item: AdminItem) => boolean]> = [
  ["all", "전체", () => true],
  ["active", "진행", (item) => ["queued", "claimed", "running"].includes(text(item.state, "")) && !stumbled(item)],
  ["failed", "실패", stumbled],
  ["done", "완료", (item) => ["candidate_ready", "published", "cancelled"].includes(text(item.state, ""))],
];

export function JobsView({
  items,
  refresh,
  onSelect,
}: {
  items: AdminItem[];
  refresh: () => void;
  onSelect: (recordingId: string) => void;
}) {
  const { showToast } = useToast();
  const [filter, setFilter] = useState<JobFilter>("all");
  const visible = items.filter((item) => (filters.find(([id]) => id === filter)?.[2] ?? (() => true))(item));

  async function retry(id: string): Promise<void> {
    try {
      await api(`/jobs/${id}/retry`, { method: "POST", body: "{}" });
      showToast("작업을 다시 대기열에 넣었습니다.");
      refresh();
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "작업 재시도 실패", { variant: "error" });
    }
  }

  async function cancel(id: string): Promise<void> {
    if (!window.confirm("이 작업을 취소합니다. 실행 중이라면 Generator가 현재 단계를 마친 뒤 중단합니다. 계속할까요?")) return;
    try {
      await api(`/jobs/${id}/cancel`, { method: "POST", body: "{}" });
      showToast("작업 취소를 요청했습니다.");
      refresh();
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "작업 취소 실패", { variant: "error" });
    }
  }

  if (items.length === 0)
    return (
      <div className="empty-panel">
        <LoaderCircle size={20} />
        <strong>대기 중인 작업이 없습니다</strong>
        <p>Collector가 곡을 전송하면 여기에 처리 단계가 나타납니다.</p>
      </div>
    );

  return (
    <div className="jobs-view">
      <nav className="review-tabs" role="tablist" aria-label="작업 상태">
        {filters.map(([id, label, match]) => (
          <button key={id} role="tab" aria-selected={filter === id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>
            <span>{label}</span>
            <b>{items.filter((item) => match(item)).length}</b>
          </button>
        ))}
      </nav>

      <div className="job-list">
        {visible.map((item) => {
          const id = text(item.id);
          const state = text(item.state, "unknown");
          const progress = Math.max(0, Math.min(1, number(item.progress)));
          const running = state === "running" || state === "claimed";
          // unsupported_language gets its own friendly line below instead of a raw error code.
          const failed = stumbled(item) && state !== "unsupported_language";
          const recordingId = text(item.recording_id);
          return (
            <article
              key={id}
              className={`job-row ${recordingId === "" ? "" : "row-link"}`}
              {...(recordingId === ""
                ? {}
                : {
                    tabIndex: 0,
                    role: "button",
                    "aria-label": `${text(item.title, "제목 없음")} 곡 상세 보기`,
                    onClick: () => onSelect(recordingId),
                    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(recordingId);
                      }
                    },
                  })}
            >
              <div className="job-row-main">
                <div className="job-song">
                  <strong>{text(item.title, "제목 없음")}</strong>
                  <span>{text(item.artist, "아티스트 미상")}</span>
                </div>
                <div className="job-status">
                  {running && (
                    <>
                      <span className="job-stage">{stageLabel(item.current_stage) || "준비 중"}</span>
                      <span className="job-bar" aria-label={`진행률 ${Math.round(progress * 100)}%`}>
                        <i style={{ width: `${progress * 100}%` }} />
                      </span>
                      <b>{Math.round(progress * 100)}%</b>
                    </>
                  )}
                  {state === "queued" && !failed && <span className="job-stage">할당 대기</span>}
                  {failed && (
                    <span className="job-fail">
                      {stageLabel(item.current_stage) || "처리"} 실패
                      {typeof item.error_code === "string" && <code>{item.error_code}</code>}
                      <em>
                        {number(item.attempt_count)}/{number(item.max_attempts, 3)}회 시도
                      </em>
                    </span>
                  )}
                  {/* 코드만 놓고는 다시 돌리는 것 말고 할 일이 떠오르지 않는다. 이 실패는 음원이 잘못 뽑힌 것이라 사람이 고를 수 있다. */}
                  {item.error_code === "NO_VOCAL_TRACK" && (
                    <span className="job-stage">노래가 없는 반주 음원입니다 — 다른 후보를 고르세요</span>
                  )}
                  {/* Terminal states: the badge already names the state, so this line says what happens next. */}
                  {state === "candidate_ready" && <span className="job-stage">타이밍 검수 대기</span>}
                  {state === "published" && <span className="job-stage">공개 API에 반영됨</span>}
                  {state === "unsupported_language" && <span className="job-stage">정렬 모델이 없는 언어입니다</span>}
                </div>
              </div>
              <div className="job-row-side">
                <span className={`state-badge ${stateTone(state)}`}>{stateLabel(state)}</span>
                <time>{relativeTime(item.updated_at)}</time>
                <div className="job-actions" onClick={(event) => event.stopPropagation()}>
                  {/*
                    실패만 다시 돌릴 수 있는 게 아니다. 정렬 코드를 고친 뒤 이미 끝난 작업을
                    새 코드로 다시 만드는 일이 더 잦고, 그때 버튼이 없어서 손댈 방법이 없었다.
                  */}
                  {DONE_STATES.includes(state) && (
                    <button className="job-retry" onClick={() => void retry(id)}>
                      <RotateCcw size={13} />
                      {state === "failed" ? "재시도" : "다시 만들기"}
                    </button>
                  )}
                  {["queued", "claimed", "running", "failed"].includes(state) && item.cancel_requested !== 1 && (
                    <button className="job-cancel" onClick={() => void cancel(id)} title="작업 취소" aria-label="작업 취소">
                      <Ban size={13} />
                    </button>
                  )}
                  {item.cancel_requested === 1 && state !== "cancelled" && (
                    <span className="job-cancelling">
                      <Ban size={12} />
                      취소 요청됨
                    </span>
                  )}
                </div>
              </div>
            </article>
          );
        })}
        {visible.length === 0 && <p className="filter-empty">이 상태의 작업이 없습니다.</p>}
      </div>
    </div>
  );
}
