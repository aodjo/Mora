import { Activity, Archive, AudioLines, Database, FileClock, ListChecks, LogOut, Radio, RefreshCw, Settings, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, liveEvents, type AuthStatus } from "./api";
import { Auth } from "./Auth";
import { Editor } from "./Editor";
import { SettingsPanel } from "./Settings";
import { ThemeToggle, type Theme } from "./ThemeToggle";

type Page = "overview" | "jobs" | "workers" | "recordings" | "review" | "audit" | "settings";
const pages: Array<[Page, string, typeof Activity]> = [["overview","상황판",Activity],["jobs","작업 큐",ListChecks],["workers","워커",Radio],["recordings","곡과 리비전",Database],["review","검수·편집",AudioLines],["audit","감사 로그",FileClock],["settings","권한·설정",Settings]];
const descriptions: Record<Page, string> = {
  overview: "전체 처리 상태와 주요 지표를 확인합니다.",
  jobs: "수집 및 생성 작업의 진행 상태를 관리합니다.",
  workers: "연결된 Generator 워커의 상태를 확인합니다.",
  recordings: "곡과 정렬 리비전을 조회합니다.",
  review: "생성된 타이밍을 검수하고 수정합니다.",
  audit: "관리 작업과 보안 이벤트를 추적합니다.",
  settings: "런타임 설정과 서비스 자격증명을 관리합니다."
};

function time(value: unknown): string { return typeof value === "number" ? new Date(value).toLocaleString("ko-KR") : "—"; }
function initialTheme(): Theme {
  const stored = window.localStorage.getItem("mora-theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [page, setPage] = useState<Page>("overview");
  const [data, setData] = useState<Record<string, unknown>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("mora-theme", theme);
  }, [theme]);
  const refreshAuth = useCallback(() => void api<AuthStatus>("/auth/status").then(setAuth), []);
  useEffect(refreshAuth, [refreshAuth]);
  const refresh = useCallback(() => {
    if (auth?.actor === null || auth === null) return;
    const path = page === "review" ? "/candidates" : page === "settings" ? "/overview" : `/${page}`;
    void api<Record<string, unknown>>(path).then(setData);
  }, [auth, page]);
  useEffect(refresh, [refresh]);
  useEffect(() => { if (auth?.actor === null || auth === null) return; const close = liveEvents(() => { setLive(true); refresh(); window.setTimeout(() => setLive(false), 1000); }); return close; }, [auth, refresh]);
  const toggleTheme = () => setTheme((current) => current === "dark" ? "light" : "dark");
  if (auth === null) return <div className="loading-screen"><span className="brand-mark">M</span><span>Mora를 불러오는 중…</span></div>;
  if (auth.actor === null) return <Auth status={auth} onAuthenticated={refreshAuth} theme={theme} onToggleTheme={toggleTheme}/>;
  const items = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : [];
  const activeLabel = pages.find(([id]) => id === page)?.[1];
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">M</span><div><p>Mora</p><span>Admin</span></div></div>
      <div className="nav-label">관리</div>
      <nav className="nav-list">{pages.map(([id,label,Icon]) => <button key={id} onClick={() => {setPage(id);setSelected(null);}} className={`nav-item ${page===id?"active":""}`}><Icon size={17}/><span>{label}</span></button>)}</nav>
      <div className="sidebar-footer"><div className="account-row"><span className="avatar">{auth.actor.id.slice(0,1).toUpperCase()}</span><div><span>관리자</span><code>{auth.actor.id.slice(0,8)}</code></div></div><button onClick={() => void api("/auth/logout",{method:"POST",body:"{}"}).then(refreshAuth)} className="logout-button" title="로그아웃"><LogOut size={16}/></button></div>
    </aside>
    <main className="main-content">
      <header className="topbar"><div className="breadcrumb"><span>Mora</span><b>/</b><strong>{activeLabel}</strong></div><div className="topbar-actions"><span className="connection"><i className={live?"busy":""}/>실시간 연결</span><ThemeToggle theme={theme} onToggle={toggleTheme}/></div></header>
      <nav className="mobile-nav">{pages.map(([id,label,Icon]) => <button key={id} onClick={() => {setPage(id);setSelected(null);}} className={page===id?"active":""}><Icon size={16}/><span>{label}</span></button>)}</nav>
      <div className="page-content">
        <div className="page-heading"><div><h1>{selected !== null && page === "review" ? "타이밍 편집" : activeLabel}</h1><p>{selected !== null && page === "review" ? "단어별 시작·종료 시간을 검수합니다." : descriptions[page]}</p></div>{page !== "overview" && page !== "settings" && selected === null && <button onClick={refresh} className="secondary-button"><RefreshCw size={14}/>새로고침</button>}</div>
        {page==="overview" ? <Overview data={data}/> : page==="review" && selected!==null ? <Editor candidateId={selected}/> : page==="settings" ? <SettingsPanel/> : <Table page={page} items={items} onSelect={page==="review"?setSelected:undefined} refresh={refresh}/>}
      </div>
    </main>
  </div>;
}

function Overview({data}:{data:Record<string,unknown>}) { const jobs=(data.jobs??{}) as Record<string,number>; const workers=(data.workers??{}) as Record<string,number>; const cards=[["대기 작업",jobs.queued??0,ListChecks],["실행 중",jobs.running??0,Activity],["검수 대기",Number(data.review_count??0),ShieldCheck],["정상 워커",`${workers.healthy??0}/${workers.total??0}`,Radio],["전체 곡",Number(data.recording_count??0),Archive]] as const; const healthy=(workers.total??0)>0&&(workers.healthy??0)===(workers.total??0); return <div className="space-y-5"><section className="status-banner"><span className={`status-icon ${healthy?"healthy":"idle"}`}><Activity size={18}/></span><div><h2>{healthy ? "모든 워커가 정상입니다" : (workers.total??0) === 0 ? "연결된 워커가 없습니다" : "확인이 필요한 워커가 있습니다"}</h2><p>{jobs.running??0}개 작업 실행 중 · {jobs.queued??0}개 작업 대기 중</p></div></section><div className="metrics-grid">{cards.map(([label,value,Icon])=><article key={label} className="metric-card"><div className="metric-icon"><Icon size={18}/></div><p>{value}</p><span>{label}</span></article>)}</div></div> }

function Table({page,items,onSelect,refresh}:{page:Page;items:Array<Record<string,unknown>>;onSelect?:((id:string)=>void);refresh:()=>void}) { return <div className="data-panel"><div className="data-panel-head"><span>{items.length}개 항목</span></div><div className="overflow-x-auto"><table className="data-table"><thead><tr>{["ID","상태/이름","단계/Backend","품질/진행","업데이트","작업"].map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{items.length===0?<tr><td colSpan={6} className="empty-state">표시할 항목이 없습니다.</td></tr>:items.map((item,index)=><tr key={String(item.id??index)}><td className="id-cell">{String(item.id??"—")}</td><td>{String(item.status??item.state??item.name??item.title??"—")}</td><td className="muted-cell">{String(item.current_stage??item.backend??item.artist??item.action??"—")}</td><td className="muted-cell">{item.quality_score===undefined?String(item.progress??"—"):Number(item.quality_score).toFixed(3)}</td><td className="date-cell">{time(item.updated_at??item.last_seen_at??item.created_at)}</td><td>{onSelect&&<button onClick={()=>onSelect(String(item.id))} className="table-action">편집</button>}{page==="jobs"&&<button onClick={()=>void api(`/jobs/${String(item.id)}/retry`,{method:"POST",body:"{}"}).then(refresh)} className="table-action">재시도</button>}</td></tr>)}</tbody></table></div></div> }
