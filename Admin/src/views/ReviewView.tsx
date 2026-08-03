import { AlertTriangle, AudioLines, Check, ChevronRight, ExternalLink, Gauge, Link2, Microchip, Music2, WandSparkles } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { api } from "../api";
import { useToast } from "../Toast";
import { number, parseObject, shortId, stateLabel, stateTone, text, time, type AdminItem } from "./utils";

const qualityNames: Record<string, string> = { duration_match: "길이", language_match: "언어", monotonicity: "순서", token_coverage: "토큰" };

export function ReviewView({ sourceItems, candidateItems, onSelect, refresh }: { sourceItems: AdminItem[]; candidateItems: AdminItem[]; onSelect: (id: string) => void; refresh: () => void }) {
  const [tab, setTab] = useState<"source" | "timing">("source");
  const actionable = sourceItems.filter((item) => Array.isArray(item.sources) && item.sources.length > 0 && typeof item.isrc === "string" && number(item.lyrics_count) > 0).length;
  return <div className="review-workspace">
    <div className="review-tabs" role="tablist" aria-label="검수 종류">
      <button role="tab" aria-selected={tab === "source"} className={tab === "source" ? "active" : ""} onClick={() => setTab("source")}><Link2 size={14}/><span>소스 검수</span><b>{sourceItems.length}</b></button>
      <button role="tab" aria-selected={tab === "timing"} className={tab === "timing" ? "active" : ""} onClick={() => setTab("timing")}><AudioLines size={14}/><span>타이밍 검수</span><b>{candidateItems.length}</b></button>
    </div>
    {tab === "source" ? <SourceReviews items={sourceItems} actionable={actionable} refresh={refresh}/> : <TimingReviews items={candidateItems} onSelect={onSelect}/>}
  </div>;
}

function SourceReviews({ items, actionable, refresh }: { items: AdminItem[]; actionable: number; refresh: () => void }) {
  if (items.length === 0) return <div className="empty-panel"><Link2 size={20}/><strong>검수할 음원 소스가 없습니다</strong><p>소스가 확정되지 않은 리비전이 생기면 여기에 표시됩니다.</p></div>;
  return <div className="source-review-section"><div className="source-review-summary"><div><strong>{items.length}</strong><span>소스 확정 대기</span></div><div><strong>{actionable}</strong><span>즉시 작업 생성 가능</span></div><p>후보를 승인하거나 YouTube Music URL을 직접 입력하면 Generator 작업이 즉시 생성됩니다.</p></div><div className="source-review-list">{items.map((item) => <SourceReviewCard key={text(item.input_revision_id)} item={item} refresh={refresh}/>)}</div></div>;
}

function SourceReviewCard({ item, refresh }: { item: AdminItem; refresh: () => void }) {
  const { showToast } = useToast();
  const [manualUrl, setManualUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const inputId = text(item.input_revision_id);
  const sources = Array.isArray(item.sources) ? item.sources.filter((value): value is AdminItem => typeof value === "object" && value !== null) : [];
  const hasIsrc = typeof item.isrc === "string" && item.isrc.length > 0;
  const hasLyrics = number(item.lyrics_count) > 0;
  const blocked = !hasIsrc || !hasLyrics;

  async function approve(value: { source_id: string } | { url: string }): Promise<void> {
    setBusy(true);
    try {
      await api(`/source-reviews/${encodeURIComponent(inputId)}/select`, { method: "POST", body: JSON.stringify(value) });
      showToast("소스를 확정하고 Generator 작업을 생성했습니다.");
      refresh();
    } catch (reason) { showToast(reason instanceof Error ? reason.message : "소스 승인 실패", { variant: "error" }); }
    finally { setBusy(false); }
  }

  return <article className="source-review-card">
    <header><span className="source-review-icon"><Music2 size={17}/></span><div><h2>{text(item.title, "제목 없음")}</h2><p>{text(item.artist, "아티스트 미상")} · {text(item.album, "앨범 정보 없음")}</p></div><span className={`state-badge ${blocked ? "bad" : sources.length > 0 ? "warn" : "neutral"}`}>{blocked ? "정보 보완 필요" : sources.length > 0 ? "후보 선택 필요" : "후보 없음"}</span></header>
    <div className="source-review-meta"><code>{text(item.isrc, "ISRC 없음")}</code><span>전처리 가사 {number(item.lyrics_count)}개</span><span>후보 {sources.length}개</span><time>{time(item.created_at)}</time></div>
    {blocked && <div className="source-blocker"><AlertTriangle size={14}/><span>{!hasIsrc && "ISRC가 없습니다. "}{!hasLyrics && "전처리 가사가 없습니다. "}곡 정보를 보완해야 작업을 생성할 수 있습니다.</span></div>}
    {sources.length > 0 && <div className="source-options">{sources.map((source) => {
      const metadata = parseObject(source.metadata);
      return <div key={text(source.id)} className="source-option"><div><strong>{text(metadata.title, `YouTube ${text(source.video_id)}`)}</strong><a href={text(source.url)} target="_blank" rel="noreferrer">{text(source.url)}<ExternalLink size={11}/></a></div><span className="source-score">{Math.round(number(source.score) * 100)}%</span>{source.official === true && <span className="source-official">공식</span>}<button disabled={blocked || busy} onClick={() => void approve({ source_id: text(source.id) })}><Check size={13}/>선택</button></div>;
    })}</div>}
    <div className="manual-source"><input value={manualUrl} onChange={(event) => setManualUrl(event.target.value)} disabled={blocked || busy} type="url" placeholder="https://music.youtube.com/watch?v=…" className="form-control"/><button disabled={blocked || busy || manualUrl.length === 0} onClick={() => void approve({ url: manualUrl })} className="secondary-button"><Link2 size={13}/>직접 지정</button></div>
  </article>;
}

function TimingReviews({ items, onSelect }: { items: AdminItem[]; onSelect: (id: string) => void }) {
  if (items.length === 0) return <div className="empty-panel"><AudioLines size={20}/><strong>검수할 타이밍 후보가 없습니다</strong><p>Generator가 정렬을 마치면 품질 지표와 함께 표시됩니다.</p></div>;
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
