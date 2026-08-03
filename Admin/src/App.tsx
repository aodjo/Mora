import { Activity, Archive, AudioLines, Database, FileClock, KeyRound, ListChecks, LogOut, Radio, RefreshCw, Settings, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, liveEvents, type AuthStatus } from "./api";
import { Auth } from "./Auth";
import { Editor } from "./Editor";
import { ConnectionsPanel, SettingsPanel } from "./Settings";
import { ThemeToggle, type Theme } from "./ThemeToggle";
import { AuditView } from "./views/AuditView";
import { JobsView } from "./views/JobsView";
import { RecordingsView } from "./views/RecordingsView";
import { ReviewView } from "./views/ReviewView";
import { WorkersView } from "./views/WorkersView";

type Page = "overview" | "jobs" | "workers" | "recordings" | "review" | "connections" | "audit" | "settings";
const pages: Array<[Page, string, typeof Activity]> = [["overview","상황판",Activity],["jobs","작업 큐",ListChecks],["workers","워커",Radio],["recordings","곡과 리비전",Database],["review","검수·편집",AudioLines],["connections","기기 연결",KeyRound],["audit","감사 로그",FileClock],["settings","권한·설정",Settings]];
const descriptions: Record<Page, string> = {
  overview: "전체 처리 상태와 주요 지표를 확인합니다.",
  jobs: "수집 및 생성 작업의 진행 상태를 관리합니다.",
  workers: "연결된 Generator 워커의 상태를 확인합니다.",
  recordings: "곡과 정렬 리비전을 조회합니다.",
  review: "음원 소스를 확정하고 생성된 타이밍을 검수합니다.",
  connections: "Collector와 Generator의 10자리 PIN 연결을 승인합니다.",
  audit: "관리 작업과 보안 이벤트를 추적합니다.",
  settings: "런타임 설정과 서비스 자격증명을 관리합니다."
};

function initialTheme(): Theme {
  try {
    const stored = window.localStorage.getItem("mora-theme");
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch { return "light"; }
}

export default function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authError, setAuthError] = useState("");
  const [page, setPage] = useState<Page>("overview");
  const [data, setData] = useState<Record<string, unknown>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try { window.localStorage.setItem("mora-theme", theme); } catch { /* storage can be blocked in embedded/private contexts */ }
  }, [theme]);
  const refreshAuth = useCallback(() => {
    setAuthError("");
    void api<AuthStatus>("/auth/status")
      .then((status) => { setAuth(status); setAuthError(""); })
      .catch((reason: unknown) => {
        setAuthError(reason instanceof Error ? reason.message : "Admin API에 연결할 수 없습니다.");
      });
  }, []);
  useEffect(refreshAuth, [refreshAuth]);
  const refresh = useCallback(() => {
    if (auth?.actor === null || auth === null) return;
    const path = page === "review" ? "/reviews" : page === "settings" || page === "connections" ? "/overview" : `/${page}`;
    void api<Record<string, unknown>>(path).then(setData);
  }, [auth, page]);
  useEffect(refresh, [refresh]);
  useEffect(() => { if (auth?.actor === null || auth === null) return; const close = liveEvents(() => { setLive(true); refresh(); window.setTimeout(() => setLive(false), 1000); }); return close; }, [auth, refresh]);
  const toggleTheme = () => setTheme((current) => current === "dark" ? "light" : "dark");
  if (auth === null) return <div className="loading-screen"><span className="brand-mark">M</span><div><span>{authError ? "Admin에 연결하지 못했습니다." : "Mora를 불러오는 중…"}</span>{authError&&<><code>{authError}</code><button onClick={refreshAuth} className="secondary-button"><RefreshCw size={14}/>다시 시도</button></>}</div></div>;
  if (auth.actor === null) return <Auth status={auth} onAuthenticated={refreshAuth} theme={theme} onToggleTheme={toggleTheme}/>;
  const items = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : [];
  const sourceItems = Array.isArray(data.source_items) ? data.source_items as Array<Record<string, unknown>> : [];
  const candidateItems = Array.isArray(data.candidate_items) ? data.candidate_items as Array<Record<string, unknown>> : [];
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
        {page==="overview" ? <Overview data={data}/>
          : page==="jobs" ? <JobsView items={items} refresh={refresh}/>
          : page==="workers" ? <WorkersView items={items}/>
          : page==="recordings" ? <RecordingsView items={items}/>
          : page==="review" && selected!==null ? <Editor candidateId={selected}/>
          : page==="review" ? <ReviewView sourceItems={sourceItems} candidateItems={candidateItems} onSelect={setSelected} refresh={refresh}/>
          : page==="audit" ? <AuditView items={items}/>
          : page==="connections" ? <ConnectionsPanel/>
          : <SettingsPanel/>}
      </div>
    </main>
  </div>;
}

function Overview({data}:{data:Record<string,unknown>}) { const jobs=(data.jobs??{}) as Record<string,number>; const workers=(data.workers??{}) as Record<string,number>; const cards=[["대기 작업",jobs.queued??0,ListChecks],["실행 중",jobs.running??0,Activity],["검수 대기",Number(data.review_count??0),ShieldCheck],["정상 워커",`${workers.healthy??0}/${workers.total??0}`,Radio],["전체 곡",Number(data.recording_count??0),Archive]] as const; const healthy=(workers.total??0)>0&&(workers.healthy??0)===(workers.total??0); return <div className="space-y-5"><section className="status-banner"><span className={`status-icon ${healthy?"healthy":"idle"}`}><Activity size={18}/></span><div><h2>{healthy ? "모든 워커가 정상입니다" : (workers.total??0) === 0 ? "연결된 워커가 없습니다" : "확인이 필요한 워커가 있습니다"}</h2><p>{jobs.running??0}개 작업 실행 중 · {jobs.queued??0}개 작업 대기 중</p></div></section><div className="metrics-grid">{cards.map(([label,value,Icon])=><article key={label} className="metric-card"><div className="metric-icon"><Icon size={18}/></div><p>{value}</p><span>{label}</span></article>)}</div></div> }
