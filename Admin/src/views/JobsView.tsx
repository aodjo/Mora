import { AlertTriangle, Clock3, LoaderCircle, RotateCcw, UserRound } from "lucide-react";
import { api } from "../api";
import { useToast } from "../Toast";
import { number, shortId, stateLabel, stateTone, text, time, type AdminItem } from "./utils";

export function JobsView({ items, refresh }: { items: AdminItem[]; refresh: () => void }) {
  const { showToast } = useToast();
  const queued = items.filter((item) => item.state === "queued").length;
  const running = items.filter((item) => item.state === "running" || item.state === "claimed").length;
  const failed = items.filter((item) => item.state === "failed").length;

  async function retry(id: string): Promise<void> {
    try {
      await api(`/jobs/${id}/retry`, { method: "POST", body: "{}" });
      showToast("작업을 다시 대기열에 넣었습니다.");
      refresh();
    } catch (reason) { showToast(reason instanceof Error ? reason.message : "작업 재시도 실패", { variant: "error" }); }
  }

  return <div className="jobs-view">
    <section className="queue-summary" aria-label="작업 큐 요약">
      <div><span>대기</span><strong>{queued}</strong></div>
      <div><span>처리 중</span><strong>{running}</strong></div>
      <div><span>실패</span><strong>{failed}</strong></div>
      <p>우선순위와 생성 시각 순으로 Generator에 할당됩니다.</p>
    </section>
    {items.length === 0 ? <EmptyJobs/> : <div className="job-list">{items.map((item) => {
      const progress = Math.max(0, Math.min(1, number(item.progress)));
      const id = text(item.id);
      const state = text(item.state, "unknown");
      return <article key={id} className="job-card">
        <div className="job-card-top">
          <div className="job-identity"><span className={`state-dot ${stateTone(state)}`}/><div><strong>{stateLabel(state)}</strong><code title={id}>{shortId(id)}</code></div></div>
          <span className={`state-badge ${stateTone(state)}`}>{stateLabel(state)}</span>
        </div>
        <div className="job-stage-row"><div><span>현재 단계</span><strong>{text(item.current_stage, state === "queued" ? "할당 대기" : "준비 중")}</strong></div><b>{Math.round(progress * 100)}%</b></div>
        <div className="job-progress" aria-label={`진행률 ${Math.round(progress * 100)}%`}><i style={{ width: `${progress * 100}%` }}/></div>
        <div className="job-meta">
          <span><RotateCcw size={13}/>{number(item.attempt_count)}/{number(item.max_attempts, 3)}회</span>
          <span><UserRound size={13}/>{shortId(item.worker_id)}</span>
          <span><Clock3 size={13}/>{time(item.updated_at)}</span>
          {typeof item.error_code === "string" && <span className="job-error"><AlertTriangle size={13}/>{item.error_code}</span>}
        </div>
        {state === "failed" && <button className="job-retry" onClick={() => void retry(id)}><RotateCcw size={14}/>재시도</button>}
      </article>;
    })}</div>}
  </div>;
}

function EmptyJobs() { return <div className="empty-panel"><LoaderCircle size={20}/><strong>대기 중인 작업이 없습니다</strong><p>Collector가 곡을 전송하면 여기에 처리 단계가 나타납니다.</p></div>; }
