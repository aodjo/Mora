import { CheckCircle2, Disc3, Hourglass } from "lucide-react";
import { useState } from "react";
import { number, stageLabel, text, time, type AdminItem } from "./utils";

function duration(value: unknown): string {
  const total = Math.max(0, Math.round(number(value) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function RecordingsView({ items, onSelect }: { items: AdminItem[]; onSelect: (id: string) => void }) {
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
        <div className="table-wrap">
          <table className="data-table recording-table">
            <thead>
              <tr>
                <th scope="col">곡</th>
                <th scope="col">앨범</th>
                <th scope="col" className="numeric">
                  길이
                </th>
                <th scope="col">ISRC</th>
                <th scope="col" className="numeric">
                  언어
                </th>
                <th scope="col" className="numeric">
                  리비전
                </th>
                <th scope="col" className="numeric">
                  후보
                </th>
                <th scope="col">상태</th>
                <th scope="col">최종 변경</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(({ item, lifecycle }) => (
                <tr
                  key={text(item.id)}
                  className="row-link"
                  tabIndex={0}
                  role="button"
                  aria-label={`${text(item.title, "제목 없음")} 상세 보기`}
                  onClick={() => onSelect(text(item.id))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(text(item.id));
                    }
                  }}
                >
                  <td>
                    <div className="cell-song">
                      <strong>{text(item.title, "제목 없음")}</strong>
                      <span>{text(item.artist, "아티스트 미상")}</span>
                    </div>
                  </td>
                  <td className="cell-muted">{text(item.album, "—")}</td>
                  <td className="numeric cell-mono">{duration(item.duration_ms)}</td>
                  <td className="cell-mono">{text(item.isrc, "—")}</td>
                  <td className="numeric cell-muted">{text(item.language, "und").toUpperCase()}</td>
                  <td className="numeric cell-mono">{number(item.revision_count)}</td>
                  <td className="numeric cell-mono">{number(item.alignment_count)}</td>
                  <td>
                    <span className={`state-badge ${lifecycle.tone}`}>{lifecycle.label}</span>
                  </td>
                  <td className="cell-muted">{time(item.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
    return { group: "pending", label: stageLabel(item.current_stage) || "처리 중", tone: "live" };
  if (item.job_state === "failed" || item.job_state === "cancelled") return { group: "pending", label: "처리 실패", tone: "bad" };
  if (item.job_state === "review_required") return { group: "pending", label: "검수 대기", tone: "warn" };
  if (item.job_state === "queued") return { group: "pending", label: "생성 대기", tone: "warn" };
  if (number(item.source_count) < 1) return { group: "pending", label: "소스 없음", tone: "bad" };
  return { group: "pending", label: "소스 검수 대기", tone: "warn" };
}
