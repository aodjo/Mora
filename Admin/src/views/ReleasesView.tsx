import { Globe, Undo2 } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { useToast } from "../Toast";
import { shortId, stateLabel, stateTone, text, time, type AdminItem } from "./utils";

export function ReleasesView({ items, refresh }: { items: AdminItem[]; refresh: () => void }) {
  const { showToast } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function withdraw(id: string): Promise<void> {
    if (!window.confirm("이 릴리스를 철회합니다. 공개 API에서 즉시 내려가며 다음 주간 덤프에도 포함되지 않습니다. 계속할까요?")) return;
    setBusyId(id);
    try {
      await api(`/releases/${encodeURIComponent(id)}/withdraw`, { method: "POST", body: "{}" });
      showToast("릴리스를 철회했습니다.");
      refresh();
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "릴리스 철회 실패", { variant: "error" });
    } finally {
      setBusyId(null);
    }
  }

  if (items.length === 0)
    return (
      <div className="empty-panel">
        <Globe size={20} />
        <strong>공개된 릴리스가 없습니다</strong>
        <p>검수·편집에서 후보를 승인하면 여기에 공개 이력이 쌓입니다.</p>
      </div>
    );
  return (
    <div className="releases-view">
      <div className="release-list">
        {items.map((item) => {
          const id = text(item.id);
          const state = text(item.state, "unknown");
          return (
            <article key={id} className="release-card">
              <div className="release-main">
                <div className="release-head">
                  <div className="release-song">
                    <strong>{text(item.title, "제목 없음")}</strong>
                    <span>{text(item.artist, "아티스트 미상")}</span>
                  </div>
                  <span className={`state-badge ${stateTone(state)}`}>{stateLabel(state)}</span>
                </div>
                <div className="release-meta">
                  <code>{text(item.isrc, "ISRC 없음")}</code>
                  <span title={text(item.candidate_id)}>후보 {shortId(item.candidate_id)}</span>
                  <time>{time(item.created_at)}</time>
                </div>
              </div>
              {state === "active" && (
                <button disabled={busyId === id} onClick={() => void withdraw(id)} className="release-withdraw">
                  <Undo2 size={14} />
                  철회
                </button>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
