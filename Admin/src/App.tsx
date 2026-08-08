import {
  Activity,
  Archive,
  AudioLines,
  Database,
  FileClock,
  Globe,
  KeyRound,
  ListChecks,
  LogOut,
  Radio,
  RefreshCw,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, liveEvents, type AuthStatus } from "./api";
import { Auth } from "./Auth";
import { Editor } from "./Editor";
import { ConnectionsPanel, SettingsPanel } from "./Settings";
import { ThemeToggle, type Theme } from "./ThemeToggle";
import { AuditView } from "./views/AuditView";
import { JobsView } from "./views/JobsView";
import { RecordingsView } from "./views/RecordingsView";
import { ReleasesView } from "./views/ReleasesView";
import { ReviewView } from "./views/ReviewView";
import { WorkersView } from "./views/WorkersView";

type Page = "overview" | "jobs" | "workers" | "recordings" | "review" | "releases" | "connections" | "audit" | "settings";
const pages: Array<[Page, string, typeof Activity]> = [
  ["overview", "상황판", Activity],
  ["jobs", "작업 큐", ListChecks],
  ["workers", "워커", Radio],
  ["recordings", "곡과 리비전", Database],
  ["review", "검수·편집", AudioLines],
  ["releases", "릴리스", Globe],
  ["connections", "기기 연결", KeyRound],
  ["audit", "감사 로그", FileClock],
  ["settings", "권한·설정", Settings],
];
const descriptions: Record<Page, string> = {
  overview: "전체 처리 상태와 주요 지표를 확인합니다.",
  jobs: "수집 및 생성 작업의 진행 상태를 관리합니다.",
  workers: "연결된 Generator 워커의 상태를 확인합니다.",
  recordings: "곡과 정렬 리비전을 조회합니다.",
  review: "음원 소스를 확정하고 생성된 타이밍을 검수합니다.",
  releases: "공개된 타이밍을 확인하고 필요하면 철회합니다.",
  connections: "Collector와 Generator의 10자리 PIN 연결을 승인합니다.",
  audit: "관리 작업과 보안 이벤트를 추적합니다.",
  settings: "런타임 설정과 서비스 자격증명을 관리합니다.",
};

function pathFor(page: Page): string {
  if (page === "review") return "/reviews";
  // Settings and connections render their own panels; they only need the overview payload.
  if (page === "settings" || page === "connections") return "/overview";
  return `/${page}`;
}

function initialTheme(): Theme {
  try {
    const stored = window.localStorage.getItem("mora-theme");
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

export default function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authError, setAuthError] = useState("");
  const [page, setPage] = useState<Page>("overview");
  const [data, setData] = useState<Record<string, unknown>>({});
  const [loadedPage, setLoadedPage] = useState<Page | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const request = useRef(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      window.localStorage.setItem("mora-theme", theme);
    } catch {
      /* storage can be blocked in embedded/private contexts */
    }
  }, [theme]);
  const refreshAuth = useCallback(() => {
    setAuthError("");
    void api<AuthStatus>("/auth/status")
      .then((status) => {
        setAuth(status);
        setAuthError("");
      })
      .catch((reason: unknown) => {
        setAuthError(reason instanceof Error ? reason.message : "Admin API에 연결할 수 없습니다.");
      });
  }, []);
  useEffect(refreshAuth, [refreshAuth]);
  // Tagged with the page it belongs to: the payloads share a shape, so untagged data
  // from the previous page renders happily — and wrongly — in the next page's view.
  const load = useCallback(
    (mode: "switch" | "silent") => {
      if (auth?.actor === null || auth === null) return;
      const target = page;
      const ticket = ++request.current;
      if (mode === "switch") setLoadedPage(null);
      else setRefreshing(true);
      void api<Record<string, unknown>>(pathFor(target))
        .then((result) => {
          if (ticket !== request.current) return; // a later page won the race
          setData(result);
          setLoadedPage(target);
        })
        .catch(() => {
          if (ticket !== request.current) return;
          setData({});
          setLoadedPage(target); // stop waiting; the view shows its own empty state
        })
        .finally(() => {
          if (ticket === request.current) setRefreshing(false);
        });
    },
    [auth, page],
  );
  const refresh = useCallback(() => {
    load("silent");
  }, [load]);
  useEffect(() => {
    load("switch");
  }, [load]);
  useEffect(() => {
    if (auth?.actor === null || auth === null) return;
    const close = liveEvents(() => {
      setLive(true);
      refresh();
      window.setTimeout(() => setLive(false), 1000);
    });
    return close;
  }, [auth, refresh]);
  const toggleTheme = () => setTheme((current) => (current === "dark" ? "light" : "dark"));
  if (auth === null)
    return (
      <div className="loading-screen">
        <span className="brand-mark">M</span>
        <div>
          <span>{authError ? "Admin에 연결하지 못했습니다." : "Mora를 불러오는 중…"}</span>
          {authError && (
            <>
              <code>{authError}</code>
              <button onClick={refreshAuth} className="secondary-button">
                <RefreshCw size={14} />
                다시 시도
              </button>
            </>
          )}
        </div>
      </div>
    );
  if (auth.actor === null) return <Auth status={auth} onAuthenticated={refreshAuth} theme={theme} onToggleTheme={toggleTheme} />;
  const items = Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : [];
  const sourceItems = Array.isArray(data.source_items) ? (data.source_items as Array<Record<string, unknown>>) : [];
  const candidateItems = Array.isArray(data.candidate_items) ? (data.candidate_items as Array<Record<string, unknown>>) : [];
  const activeLabel = pages.find(([id]) => id === page)?.[1];
  // Settings, connections and the editor fetch their own data, so they never wait on this.
  const selfLoading = page === "settings" || page === "connections" || (page === "review" && selected !== null);
  const ready = selfLoading || loadedPage === page;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">M</span>
          <div>
            <p>Mora</p>
            <span>Admin</span>
          </div>
        </div>
        <div className="nav-label">관리</div>
        <nav className="nav-list">
          {pages.map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => {
                setPage(id);
                setSelected(null);
              }}
              className={`nav-item ${page === id ? "active" : ""}`}
            >
              <Icon size={17} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="account-row">
            <span className="avatar">{auth.actor.id.slice(0, 1).toUpperCase()}</span>
            <div>
              <span>관리자</span>
              <code>{auth.actor.id.slice(0, 8)}</code>
            </div>
          </div>
          <button
            onClick={() => void api("/auth/logout", { method: "POST", body: "{}" }).then(refreshAuth)}
            className="logout-button"
            title="로그아웃"
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Mora</span>
            <b>/</b>
            <strong>{activeLabel}</strong>
          </div>
          <div className="topbar-actions">
            <span className="connection">
              <i className={live ? "busy" : ""} />
              실시간 연결
            </span>
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </div>
        </header>
        <nav className="mobile-nav">
          {pages.map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => {
                setPage(id);
                setSelected(null);
              }}
              className={page === id ? "active" : ""}
            >
              <Icon size={16} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="page-content">
          <div className="page-heading">
            <div>
              <h1>{selected !== null && page === "review" ? "타이밍 편집" : activeLabel}</h1>
              <p>{selected !== null && page === "review" ? "단어별 시작·종료 시간을 검수합니다." : descriptions[page]}</p>
            </div>
            {page !== "overview" && page !== "settings" && selected === null && (
              <button onClick={refresh} disabled={refreshing} className="secondary-button">
                <RefreshCw size={14} className={refreshing ? "spinning" : ""} />
                새로고침
              </button>
            )}
          </div>
          {!ready ? (
            <PageSkeleton page={page} />
          ) : page === "overview" ? (
            <Overview data={data} />
          ) : page === "jobs" ? (
            <JobsView items={items} refresh={refresh} />
          ) : page === "workers" ? (
            <WorkersView items={items} refresh={refresh} />
          ) : page === "recordings" ? (
            <RecordingsView items={items} />
          ) : page === "review" && selected !== null ? (
            <Editor
              candidateId={selected}
              onPublished={() => {
                setSelected(null);
                refresh();
              }}
            />
          ) : page === "review" ? (
            <ReviewView sourceItems={sourceItems} candidateItems={candidateItems} onSelect={setSelected} refresh={refresh} />
          ) : page === "releases" ? (
            <ReleasesView items={items} refresh={refresh} />
          ) : page === "audit" ? (
            <AuditView items={items} />
          ) : page === "connections" ? (
            <ConnectionsPanel />
          ) : (
            <SettingsPanel />
          )}
        </div>
      </main>
    </div>
  );
}

interface Calibration {
  reviews: number;
  target: number;
  auto_promotion_enabled: boolean;
}

function Overview({ data }: { data: Record<string, unknown> }) {
  const jobs = (data.jobs ?? {}) as Record<string, number>;
  const workers = (data.workers ?? {}) as Record<string, number>;
  // Queued/running counts live in the banner sentence; repeating them as cards said nothing new.
  const cards = [
    ["검수 대기", Number(data.review_count ?? 0), ShieldCheck],
    ["정상 워커", `${workers.healthy ?? 0}/${workers.total ?? 0}`, Radio],
    ["공개 중", Number(data.release_count ?? 0), Globe],
    ["전체 곡", Number(data.recording_count ?? 0), Archive],
  ] as const;
  const healthy = (workers.total ?? 0) > 0 && (workers.healthy ?? 0) === (workers.total ?? 0);
  return (
    <div className="space-y-5">
      <section className="status-banner">
        <span className={`status-icon ${healthy ? "healthy" : "idle"}`}>
          <Activity size={18} />
        </span>
        <div>
          <h2>
            {healthy ? "모든 워커가 정상입니다" : (workers.total ?? 0) === 0 ? "연결된 워커가 없습니다" : "확인이 필요한 워커가 있습니다"}
          </h2>
          <p>
            {jobs.running ?? 0}개 작업 실행 중 · {jobs.queued ?? 0}개 작업 대기 중
          </p>
        </div>
      </section>
      <div className="metrics-grid">
        {cards.map(([label, value, Icon]) => (
          <article key={label} className="metric-card">
            <div className="metric-icon">
              <Icon size={18} />
            </div>
            <p>{value}</p>
            <span>{label}</span>
          </article>
        ))}
      </div>
      <CalibrationPanel value={data.calibration as Calibration | undefined} />
    </div>
  );
}

function CalibrationPanel({ value }: { value: Calibration | undefined }) {
  if (value === undefined) return null;
  const target = Math.max(1, value.target);
  const progress = Math.min(1, value.reviews / target);
  return (
    <section className="calibration-panel">
      <div className="calibration-head">
        <div>
          <h2>{value.auto_promotion_enabled ? "자동 승격이 활성화되어 있습니다" : "사람 교정 단계입니다"}</h2>
          <p>
            {value.auto_promotion_enabled
              ? "품질 임계치를 넘은 후보는 검수 없이 바로 공개됩니다. 권한·설정에서 다시 끌 수 있습니다."
              : `검수·편집에서 후보를 ${target}건 승인하면 자동 승격이 켜집니다. 지금은 모든 공개를 사람이 승인해야 합니다.`}
          </p>
        </div>
        <strong>
          {value.reviews}
          <small>/{target}</small>
        </strong>
      </div>
      <div className="calibration-bar" aria-label={`교정 진행률 ${Math.round(progress * 100)}%`}>
        <i style={{ width: `${progress * 100}%` }} />
      </div>
    </section>
  );
}

// Each page lays its list out differently — one column, two, or a card grid, some behind a
// filter bar. The placeholder borrows the real wrapper class so column count, gap and offset
// come from the same CSS the loaded page uses, instead of a second set of numbers to drift.
interface SkeletonSpec {
  view?: string; // the page wrapper, for its gap between filter bar and list
  filters?: number; // height of the filter/tab bar that sits above the list
  band?: number; // height of the summary band between the tabs and the list
  panel?: number; // height of the panel header the list is nested under
  head?: number; // height of the header row, for pages that show a table
  wrapper: string; // the real list/grid/table class, so columns and gap match
  count: number;
  height: number;
}

const skeletons: Record<Page, SkeletonSpec | null> = {
  overview: null,
  jobs: { view: "jobs-view", filters: 38, wrapper: "job-list", count: 4, height: 74 },
  workers: { wrapper: "worker-grid", count: 2, height: 316 },
  recordings: { view: "recordings-view", filters: 36, head: 41, wrapper: "table-wrap", count: 6, height: 62 },
  review: { view: "review-workspace", filters: 38, band: 76, wrapper: "source-review-list", count: 2, height: 240 },
  releases: { view: "releases-view", wrapper: "release-list", count: 4, height: 88 },
  audit: { panel: 71, wrapper: "audit-list", count: 5, height: 75 },
  connections: null,
  settings: null,
};

function PageSkeleton({ page }: { page: Page }) {
  if (page === "overview")
    return (
      <div className="space-y-5" aria-busy="true" aria-label="불러오는 중">
        <div className="skeleton-block" style={{ height: 90 }} />
        <div className="metrics-grid">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="skeleton-block" style={{ height: 104, animationDelay: `${index * 90}ms` }} />
          ))}
        </div>
      </div>
    );
  const spec = skeletons[page];
  if (spec === null) return null;
  const blocks =
    spec.head === undefined ? (
      <div className={spec.wrapper}>
        {Array.from({ length: spec.count }, (_, index) => (
          <div key={index} className="skeleton-block" style={{ height: spec.height, animationDelay: `${index * 90}ms` }} />
        ))}
      </div>
    ) : (
      // A table is one bordered panel, so the rows are strips inside it rather than cards.
      <div className={spec.wrapper}>
        <div className="skeleton-panel-head" style={{ height: spec.head }} />
        {Array.from({ length: spec.count }, (_, index) => (
          <div key={index} className="skeleton-strip" style={{ height: spec.height, animationDelay: `${index * 60}ms` }}>
            <i />
          </div>
        ))}
      </div>
    );
  if (spec.panel !== undefined)
    return (
      <section className="audit-stream" aria-busy="true" aria-label="불러오는 중">
        <div className="skeleton-panel-head" style={{ height: spec.panel }} />
        {blocks}
      </section>
    );
  return (
    <div className={spec.view ?? "skeleton-page"} aria-busy="true" aria-label="불러오는 중">
      {spec.filters !== undefined && <div className="skeleton-filters" style={{ height: spec.filters }} />}
      {spec.band !== undefined && <div className="skeleton-block" style={{ height: spec.band }} />}
      {blocks}
    </div>
  );
}
