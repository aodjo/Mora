import { useEffect, useMemo, useState } from "react";
import { api } from "./api";

type Span = [number, number];
interface Detail { id: string; lyric_text: string; line_spans: Span[]; word_spans: Array<[number, number, number]>; artifacts: Array<{ id: string; kind: string; speaker_id: number | null }> }

export function Editor({ candidateId }: { candidateId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { void api<Detail>(`/candidates/${candidateId}`).then(setDetail); void api(`/candidates/${candidateId}/lease`, { method: "POST", body: "{}" }); }, [candidateId]);
  useEffect(() => {
    if (!dirty || detail === null) return;
    const timer = window.setTimeout(() => {
      void api(`/candidates/${candidateId}/draft`, { method: "PUT", body: JSON.stringify({ line_spans: detail.line_spans, word_spans: detail.word_spans }) }).then(() => { setDirty(false); setMessage("초안 저장됨"); });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [candidateId, detail, dirty]);
  const duration = useMemo(() => Math.max(1, ...(detail?.line_spans.map((span) => span[1]) ?? [1])), [detail]);
  if (detail === null) return <p className="loading-copy">편집기를 불러오는 중…</p>;
  function change(index: number, field: 1 | 2, value: number): void {
    setDetail((current) => current === null ? current : { ...current, word_spans: current.word_spans.map((span, spanIndex) => spanIndex === index ? [span[0], field === 1 ? value : span[1], field === 2 ? value : span[2]] : span) }); setDirty(true); setMessage("편집 중");
  }
  return <div className="space-y-5">
    <div className="editor-panel">
      <div className="mb-3 flex items-center justify-between"><h3>멀티트랙 타임라인</h3><span className="save-state">{message}</span></div>
      <div className="space-y-2">{detail.artifacts.map((artifact) => <div key={artifact.id} className="artifact-row"><span>{artifact.kind}{artifact.speaker_id === null ? "" : ` ${artifact.speaker_id}`}</span><audio controls preload="none" className="h-8 flex-1" src={`/admin/api/generator/artifacts/${artifact.id}/content`} /></div>)}</div>
      <div className="timeline">{detail.word_spans.map((span, index) => <div key={index} className="timeline-span" style={{ left: `${span[1] / duration * 100}%`, width: `${Math.max(.15, (span[2] - span[1]) / duration * 100)}%` }} title={`token ${span[0]}: ${span[1]}–${span[2]}ms`} />)}</div>
    </div>
    <div className="editor-table-wrap"><table className="editor-table"><thead><tr><th>Token</th><th>Start ms</th><th>End ms</th></tr></thead><tbody>{detail.word_spans.map((span, index) => <tr key={index}><td>{span[0]}</td><td><input type="number" value={span[1]} onChange={(e) => change(index, 1, Number(e.target.value))} className="timing-input" /></td><td><input type="number" value={span[2]} onChange={(e) => change(index, 2, Number(e.target.value))} className="timing-input" /></td></tr>)}</tbody></table></div>
    <button onClick={() => void api(`/candidates/${candidateId}/submit-draft`, { method: "POST", body: "{}" }).then(() => setMessage("새 후보 리비전 제출됨"))} className="primary-button">검수 리비전 제출</button>
  </div>;
}
