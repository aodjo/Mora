import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { api } from "./api";
import { useToast } from "./Toast";

type Span = [number, number];
type WordSpan = [number, number, number];
interface ReviewToken { index:number;text:string;line:number;speaker_id:number|null;speaker_confidence:number|null }
interface ReviewLine { index:number;text:string;token_indices:number[] }
interface Artifact { id:string;kind:string;speaker_id:number|null;content_type:string;byte_size:number }
interface Detail {
  id:string;
  recording:{artist:string;title:string};
  variant:{provider:string;language:string;layer:string};
  lyric_text:string;
  tokens:ReviewToken[];
  lines:ReviewLine[];
  line_spans:Span[];
  word_spans:WordSpan[];
  artifacts:Artifact[];
}

const trackNames:Record<string,string>={source:"원본",vocals:"보컬",drums:"드럼",bass:"베이스",other:"기타 반주",speaker:"화자"};
const speakerColors=["#0070f3","#7928ca","#eb367f","#ab570a","#0c8c72","#c50000"];

export function Editor({ candidateId }: { candidateId: string }) {
  const { showToast } = useToast();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [dirty, setDirty] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [message, setMessage] = useState("");
  const [currentMs,setCurrentMs]=useState(0);
  const [mediaDuration,setMediaDuration]=useState(0);
  const audioRefs=useRef(new Map<string,HTMLAudioElement>());
  const lineRefs=useRef(new Map<number,HTMLDivElement>());
  useEffect(() => {
    void api<Detail>(`/candidates/${candidateId}`).then(setDetail).catch((reason: unknown) => showToast(reason instanceof Error ? reason.message : "편집기를 불러오지 못했습니다.", { variant: "error" }));
    void api(`/candidates/${candidateId}/lease`, { method: "POST", body: "{}" }).catch((reason: unknown) => showToast(reason instanceof Error ? reason.message : "편집 권한을 얻지 못했습니다.", { variant: "error" }));
  }, [candidateId, showToast]);
  useEffect(() => {
    if (!dirty || detail === null) return;
    const timer = window.setTimeout(() => {
      void api(`/candidates/${candidateId}/draft`, { method: "PUT", body: JSON.stringify({ line_spans: detail.line_spans, word_spans: detail.word_spans }) })
        .then(() => { setDirty(false);setDraftSaved(true);setMessage("초안 저장됨");showToast("타이밍 초안을 자동 저장했습니다."); })
        .catch((reason: unknown) => showToast(reason instanceof Error ? reason.message : "타이밍 초안 저장 실패", { variant: "error" }));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [candidateId, detail, dirty, showToast]);
  const playableArtifacts=useMemo(()=>detail?.artifacts.filter(artifact=>canPlay(artifact.content_type))??[],[detail]);
  const unsupportedCount=(detail?.artifacts.length??0)-playableArtifacts.length;
  const duration = useMemo(() => Math.max(1,mediaDuration,...(detail?.line_spans.map((span) => span[1]) ?? [1])), [detail,mediaDuration]);
  const spans=useMemo(()=>new Map(detail?.word_spans.map(span=>[span[0],span])??[]),[detail]);
  const tokens=useMemo(()=>new Map(detail?.tokens.map(token=>[token.index,token])??[]),[detail]);
  const activeSpan=detail?.word_spans.find(span=>currentMs>=span[1]&&currentMs<span[2]);
  const activeToken=activeSpan?.[0]??null;
  const activeLine=activeToken===null?null:tokens.get(activeToken)?.line??null;
  useEffect(()=>{if(activeLine!==null)lineRefs.current.get(activeLine)?.scrollIntoView({block:"nearest"});},[activeLine]);
  if (detail === null) return <p className="loading-copy">편집기를 불러오는 중…</p>;

  function change(index: number, field: 1 | 2, value: number): void {
    setDetail((current) => current === null ? current : { ...current, word_spans: current.word_spans.map((span, spanIndex) => spanIndex === index ? [span[0], field === 1 ? value : span[1], field === 2 ? value : span[2]] : span) });setDirty(true);setDraftSaved(false);setMessage("편집 중");
  }
  function seek(milliseconds:number):void{setCurrentMs(milliseconds);for(const audio of audioRefs.current.values())audio.currentTime=milliseconds/1000;}
  function play(id:string,element:HTMLAudioElement):void{for(const [otherId,audio] of audioRefs.current)if(otherId!==id)audio.pause();setCurrentMs(element.currentTime*1000);}

  return <div className="editor-layout">
    <section className="editor-panel">
      <div className="editor-title"><div><h2>{detail.recording.title}</h2><p>{detail.recording.artist} · {detail.variant.provider} · {detail.variant.language.toUpperCase()}</p></div><span className="save-state">{message}</span></div>
      <div className="editor-section-heading"><h3>검수 오디오</h3><span>{formatTime(currentMs)} / {formatTime(duration)}</span></div>
      <div className="audio-tracks">{playableArtifacts.map(artifact=><div key={artifact.id} className="artifact-row"><span>{trackName(artifact)}</span><audio ref={element=>{if(element===null)audioRefs.current.delete(artifact.id);else audioRefs.current.set(artifact.id,element);}} controls preload="metadata" src={`/admin/api/generator/artifacts/${artifact.id}/content`} onPlay={event=>play(artifact.id,event.currentTarget)} onTimeUpdate={event=>setCurrentMs(event.currentTarget.currentTime*1000)} onSeeked={event=>setCurrentMs(event.currentTarget.currentTime*1000)} onLoadedMetadata={event=>setMediaDuration(current=>Math.max(current,event.currentTarget.duration*1000))}/></div>)}</div>
      {playableArtifacts.length===0&&<p className="editor-notice">재생 가능한 검수 오디오가 없습니다. 이 작업을 다시 생성해야 합니다.</p>}
      {unsupportedCount>0&&<p className="editor-notice">현재 브라우저가 지원하지 않는 이전 형식 트랙 {unsupportedCount}개는 숨겼습니다.</p>}
      <div className="timeline" aria-label="단어 타이밍 개요">{detail.word_spans.map((span,index)=>{const token=tokens.get(span[0]);return <button key={index} className={`timeline-span${activeToken===span[0]?" active":""}`} style={{left:`${span[1]/duration*100}%`,width:`${Math.max(.15,(span[2]-span[1])/duration*100)}%`,"--speaker-color":speakerColor(token?.speaker_id)} as CSSProperties} title={`${token?.text??`토큰 ${span[0]}`} · ${formatTime(span[1])}–${formatTime(span[2])}`} onClick={()=>seek(span[1])}/>;})}</div>
    </section>

    <section className="lyrics-review-panel">
      <div className="editor-section-heading"><div><h3>가사와 문장 타이밍</h3><p>문장이나 단어를 누르면 해당 위치로 이동합니다.</p></div><span>{detail.lines.length}문장 · {detail.tokens.length}단어</span></div>
      <div className="lyrics-lines">{detail.lines.map(line=>{const lineSpans=line.token_indices.flatMap(index=>{const span=spans.get(index);return span===undefined?[]:[span];});const start=Math.min(...lineSpans.map(span=>span[1]));const end=Math.max(...lineSpans.map(span=>span[2]));return <div key={line.index} ref={element=>{if(element===null)lineRefs.current.delete(line.index);else lineRefs.current.set(line.index,element);}} className={`lyric-line${activeLine===line.index?" active":""}`}><button className="line-time" disabled={!Number.isFinite(start)} onClick={()=>seek(start)}>{Number.isFinite(start)?formatTime(start):"--:--"}</button><div><p>{line.text}</p><div className="lyric-tokens">{line.token_indices.map(index=>{const token=tokens.get(index);const span=spans.get(index);return <button key={index} disabled={span===undefined} className={`${activeToken===index?"active ":""}${span===undefined?"unmapped":""}`} style={{"--speaker-color":speakerColor(token?.speaker_id)} as CSSProperties} onClick={()=>span!==undefined&&seek(span[1])}><span>{token?.text??index}</span>{token?.speaker_id===null||token?.speaker_id===undefined?null:<small>화자 {token.speaker_id+1}</small>}</button>;})}</div>{Number.isFinite(end)&&<span className="line-range">{formatTime(start)}–{formatTime(end)}</span>}</div></div>;})}</div>
    </section>

    <div className="editor-table-wrap"><table className="editor-table"><thead><tr><th>#</th><th>가사</th><th>화자</th><th>시작 ms</th><th>종료 ms</th></tr></thead><tbody>{detail.word_spans.map((span,index)=>{const token=tokens.get(span[0]);return <tr key={index} className={activeToken===span[0]?"active":""}><td>{span[0]}</td><td className="token-text">{token?.text??"—"}</td><td>{token?.speaker_id===null||token?.speaker_id===undefined?"—":`화자 ${token.speaker_id+1}`}</td><td><input type="number" min="0" step="10" value={span[1]} onChange={(event)=>change(index,1,Number(event.target.value))} className="timing-input"/></td><td><input type="number" min="0" step="10" value={span[2]} onChange={(event)=>change(index,2,Number(event.target.value))} className="timing-input"/></td></tr>;})}</tbody></table></div>
    <button disabled={!draftSaved||dirty} onClick={()=>void submitDraft()} className="primary-button editor-submit">검수 리비전 제출</button>
  </div>;

  async function submitDraft(): Promise<void> {
    try {await api(`/candidates/${candidateId}/submit-draft`,{method:"POST",body:"{}"});setDraftSaved(false);setMessage("새 후보 리비전 제출됨");showToast("검수 리비전을 제출했습니다.");}
    catch(reason){showToast(reason instanceof Error?reason.message:"검수 리비전 제출 실패",{variant:"error"});}
  }
}

function canPlay(contentType:string):boolean{if(typeof document==="undefined")return false;const probe=document.createElement("audio");const type=contentType==="audio/ogg"?'audio/ogg; codecs="opus"':contentType;return probe.canPlayType(type)!=="";}
function trackName(artifact:Artifact):string{return `${trackNames[artifact.kind]??artifact.kind}${artifact.speaker_id===null?"":` ${artifact.speaker_id+1}`}`;}
function speakerColor(speaker:number|null|undefined):string{return speaker===null||speaker===undefined?"#8f8f8f":speakerColors[speaker%speakerColors.length]??"#8f8f8f";}
function formatTime(milliseconds:number):string{const seconds=Math.max(0,Math.floor(milliseconds/1000));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,"0")}`;}
