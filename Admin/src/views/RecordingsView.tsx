import { CheckCircle2, Clock3, Disc3, Fingerprint, GitBranch, Hourglass, Languages, Music2 } from "lucide-react";
import { useState } from "react";
import { number, shortId, text, time, type AdminItem } from "./utils";

function duration(value: unknown): string {
  const total = Math.max(0, Math.round(number(value) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function RecordingsView({ items }: { items: AdminItem[] }) {
  const [filter, setFilter] = useState<"all" | "pending" | "complete">("all");
  if (items.length === 0)
    return (
      <div className="empty-panel">
        <Disc3 size={20} />
        <strong>수집된 곡이 없습니다</strong>
        <p>Collector가 확인한 첫 곡부터 카탈로그에 추가됩니다.</p>
      </div>
    );
  const rows = items.map((item) => ({ item, lifecycle: lifecycle(item) }));
  const pending = rows.filter((row) => row.lifecycle.group === "pending").length;
  const complete = rows.length - pending;
  const visible = filter === "all" ? rows : rows.filter((row) => row.lifecycle.group === filter);
  return (
    <div className="recordings-view">
      <div className="recording-filters" role="group" aria-label="곡 처리 상태 필터">
        <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>
          <span>전체</span>
          <b>{rows.length}</b>
        </button>
        <button className={filter === "pending" ? "active" : ""} onClick={() => setFilter("pending")}>
          <Hourglass size={13} />
          <span>대기</span>
          <b>{pending}</b>
        </button>
        <button className={filter === "complete" ? "active" : ""} onClick={() => setFilter("complete")}>
          <CheckCircle2 size={13} />
          <span>완료</span>
          <b>{complete}</b>
        </button>
      </div>
      {visible.length === 0 ? (
        <div className="empty-panel compact">
          <strong>{filter === "complete" ? "완료된 곡이 없습니다" : "대기 중인 곡이 없습니다"}</strong>
        </div>
      ) : (
        <div className="recording-grid">
          {visible.map(({ item, lifecycle }) => {
            const id = text(item.id);
            return (
              <article key={id} className={`recording-card ${lifecycle.group}`}>
                <div className="recording-cover">
                  {lifecycle.group === "complete" ? <CheckCircle2 size={20} /> : <Music2 size={20} />}
                  <span>{duration(item.duration_ms)}</span>
                </div>
                <div className="recording-body">
                  <div className="recording-title">
                    <div>
                      <h2>{text(item.title, "제목 없음")}</h2>
                      <p>{text(item.artist, "아티스트 미상")}</p>
                    </div>
                    <span className={`state-badge ${lifecycle.tone}`}>{lifecycle.label}</span>
                  </div>
                  <p className="recording-album">{text(item.album, "앨범 정보 없음")}</p>
                  <div className="recording-identifiers">
                    <span>
                      <Fingerprint size={13} />
                      <code>{text(item.isrc, "ISRC 없음")}</code>
                    </span>
                    <span title={id}>ID {shortId(id)}</span>
                  </div>
                  <footer>
                    <span>
                      <GitBranch size={13} />
                      리비전 {number(item.revision_count)} · 후보 {number(item.alignment_count)}
                    </span>
                    <span>
                      <Languages size={13} />
                      {text(item.language, "und").toUpperCase()}
                    </span>
                    <span>
                      <Clock3 size={13} />
                      {time(item.updated_at)}
                    </span>
                  </footer>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface Lifecycle {
  group: "pending" | "complete";
  label: string;
  tone: "good" | "warn" | "bad" | "live";
}

function lifecycle(item: AdminItem): Lifecycle {
  if (item.published === 1) return { group: "complete", label: "게시 완료", tone: "good" };
  if (number(item.alignment_count) > 0 || item.job_state === "candidate_ready" || item.job_state === "published")
    return { group: "complete", label: "생성 완료", tone: "good" };
  if (item.job_state === "running" || item.job_state === "claimed")
    return { group: "pending", label: text(item.current_stage, "처리 중"), tone: "live" };
  if (item.job_state === "failed" || item.job_state === "cancelled") return { group: "pending", label: "처리 실패", tone: "bad" };
  if (item.job_state === "review_required") return { group: "pending", label: "검수 대기", tone: "warn" };
  if (item.job_state === "queued") return { group: "pending", label: "생성 대기", tone: "warn" };
  if (number(item.source_count) < 1) return { group: "pending", label: "소스 없음", tone: "bad" };
  return { group: "pending", label: "소스 검수 대기", tone: "warn" };
}
