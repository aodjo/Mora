import { Ban, LoaderCircle, RotateCcw } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { useToast } from "../Toast";
import { number, relativeTime, stageLabel, stateLabel, stateTone, text, type AdminItem } from "./utils";

type JobFilter = "all" | "active" | "failed" | "done";
const filters: Array<[JobFilter, string, (state: string) => boolean]> = [
  ["all", "전체", () => true],
  ["active", "진행", (state) => ["queued", "claimed", "running"].includes(state)],
  ["failed", "실패", (state) => ["failed", "unsupported_language"].includes(state)],
  ["done", "완료", (state) => ["candidate_ready", "published", "cancelled"].includes(state)],
];

export function JobsView({ items, refresh }: { items: AdminItem[]; refresh: () => void }) {
  const { showToast } = useToast();
  const [filter, setFilter] = useState<JobFilter>("all");
  const visible = items.filter((item) => (filters.find(([id]) => id === filter)?.[2] ?? (() => true))(text(item.state, "")));

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
            <b>{items.filter((item) => match(text(item.state, ""))).length}</b>
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
          const failed = state === "failed";
          return (
            <article key={id} className="job-row">
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
                  {state === "queued" && <span className="job-stage">할당 대기</span>}
                  {failed && (
                    <span className="job-fail">
                      {stageLabel(item.current_stage) || "처리"} 실패
                      {typeof item.error_code === "string" && <code>{item.error_code}</code>}
                      <em>
                        {number(item.attempt_count)}/{number(item.max_attempts, 3)}회 시도
                      </em>
                    </span>
                  )}
                  {/* Terminal states: the badge already names the state, so this line says what happens next. */}
                  {state === "candidate_ready" && <span className="job-stage">검수·편집에서 타이밍 검수 대기</span>}
                  {state === "published" && <span className="job-stage">공개 API에 반영됨</span>}
                  {state === "unsupported_language" && <span className="job-stage">정렬 모델이 없는 언어입니다</span>}
                </div>
              </div>
              <div className="job-row-side">
                <span className={`state-badge ${stateTone(state)}`}>{stateLabel(state)}</span>
                <time>{relativeTime(item.updated_at)}</time>
                <div className="job-actions">
                  {state === "failed" && (
                    <button className="job-retry" onClick={() => void retry(id)}>
                      <RotateCcw size={13} />
                      재시도
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
