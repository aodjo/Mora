import { AudioLines, ChevronRight, Gauge, Microchip, WandSparkles } from "lucide-react";
import type { CSSProperties } from "react";
import { number, parseObject, shortId, stateLabel, stateTone, text, time, type AdminItem } from "./utils";

const qualityNames: Record<string, string> = { duration_match: "길이", language_match: "언어", monotonicity: "순서", token_coverage: "토큰" };

export function ReviewView({ items, onSelect }: { items: AdminItem[]; onSelect: (id: string) => void }) {
  if (items.length === 0) return <div className="empty-panel"><AudioLines size={20}/><strong>검수할 후보가 없습니다</strong><p>Generator가 정렬을 마치면 품질 지표와 함께 표시됩니다.</p></div>;
  return <div className="review-list">{items.map((item) => {
    const id = text(item.id);
    const score = Math.max(0, Math.min(1, number(item.quality_score)));
    const quality = Object.entries(parseObject(item.quality)).filter(([key, value]) => key in qualityNames && typeof value === "number").slice(0, 4);
    return <article key={id} className="review-card">
      <div className="quality-dial" style={{ "--quality": `${score * 360}deg` } as CSSProperties}><strong>{Math.round(score * 100)}</strong><span>QUALITY</span></div>
      <div className="review-main">
        <div className="review-head"><div><span className="mono-eyebrow">CANDIDATE · {shortId(id)}</span><h2>{stateLabel(item.status)}</h2></div><span className={`state-badge ${stateTone(item.status)}`}>{stateLabel(item.status)}</span></div>
        <div className="quality-metrics">{quality.map(([key, value]) => <div key={key}><span>{qualityNames[key]}</span><div><i style={{ width: `${Math.max(0, Math.min(1, Number(value))) * 100}%` }}/></div><b>{Math.round(Number(value) * 100)}</b></div>)}</div>
        <footer><span><WandSparkles size={13}/>{text(item.pipeline_version)}</span><span><Microchip size={13}/>{text(item.backend)} · {text(item.hardware)}</span><span><Gauge size={13}/>{text(item.tokenizer)}</span><time>{time(item.created_at)}</time></footer>
      </div>
      <button className="review-open" onClick={() => onSelect(id)} aria-label="타이밍 편집"><ChevronRight size={18}/></button>
    </article>;
  })}</div>;
}
