import { Clock3, Disc3, Fingerprint, Languages, Music2 } from "lucide-react";
import { number, shortId, stateLabel, stateTone, text, time, type AdminItem } from "./utils";

function duration(value: unknown): string {
  const total = Math.max(0, Math.round(number(value) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function RecordingsView({ items }: { items: AdminItem[] }) {
  if (items.length === 0) return <div className="empty-panel"><Disc3 size={20}/><strong>수집된 곡이 없습니다</strong><p>Collector가 확인한 첫 곡부터 카탈로그에 추가됩니다.</p></div>;
  return <div className="recording-grid">{items.map((item) => {
    const id = text(item.id);
    return <article key={id} className="recording-card">
      <div className="recording-cover"><Music2 size={20}/><span>{duration(item.duration_ms)}</span></div>
      <div className="recording-body">
        <div className="recording-title"><div><h2>{text(item.title, "제목 없음")}</h2><p>{text(item.artist, "아티스트 미상")}</p></div><span className={`state-badge ${stateTone(item.identification_state)}`}>{stateLabel(item.identification_state)}</span></div>
        <p className="recording-album">{text(item.album, "앨범 정보 없음")}</p>
        <div className="recording-identifiers"><span><Fingerprint size={13}/><code>{text(item.isrc, "ISRC 없음")}</code></span><span title={id}>ID {shortId(id)}</span></div>
        <footer><span><Languages size={13}/>{text(item.language, "und").toUpperCase()}</span><span><Clock3 size={13}/>{time(item.updated_at)}</span></footer>
      </div>
    </article>;
  })}</div>;
}
