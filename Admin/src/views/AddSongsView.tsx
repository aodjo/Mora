import { Check, Loader2, Music, Plus, Search, ShoppingBasket, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { PROVIDER_ICONS } from "./provider-icons";
import { useToast } from "../Toast";

/**
 * Finding a song by name and keeping it until you mean it.
 *
 * Discovery follows charts and albums, which never reaches a song nobody charted. This is the
 * other door: search the services people actually listen on, keep what you meant across several
 * searches, then hand the lot over in one act. The searching is done by whichever Collector is
 * free — the Worker cannot reach these services, and the Collectors already do.
 */

const PROVIDERS = [
  { id: "melon", label: "멜론" },
  { id: "genie", label: "지니" },
  { id: "vibe", label: "바이브" },
  { id: "lyricfind", label: "LyricFind" },
] as const;

type ProviderId = (typeof PROVIDERS)[number]["id"];

interface Hit {
  artist: string;
  title: string;
  album?: string;
  duration_ms?: number;
  isrc?: string;
  artwork?: string;
  providers: ProviderId[];
}

interface BasketRow {
  id: string;
  artist: string;
  title: string;
  album?: string | null;
  duration_ms?: number | null;
  isrc?: string | null;
  providers: ProviderId[];
  state: string;
  error?: string | null;
}

interface SearchState {
  state: "pending" | "claimed" | "done" | "failed";
  items?: Hit[];
  error?: string;
}

const STATE_LABELS: Record<string, string> = {
  held: "담김",
  released: "전송됨",
  claimed: "수집 중",
  failed: "실패",
};

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Which services carry this song, wearing each service's own mark. */
function Badges({ providers }: { providers: ProviderId[] }) {
  const carried = PROVIDERS.filter((provider) => providers.includes(provider.id));
  if (carried.length === 0) return null;
  return (
    <span className="provider-badges" aria-label={`${carried.map((provider) => provider.label).join(", ")}에 있음`}>
      {carried.map((provider) => (
        <img key={provider.id} src={PROVIDER_ICONS[provider.id]} alt="" title={provider.label} width={18} height={18} />
      ))}
    </span>
  );
}

export function AddSongsView() {
  const { showToast } = useToast();
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<ProviderId[]>(PROVIDERS.map((provider) => provider.id));
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [failure, setFailure] = useState("");
  const [basket, setBasket] = useState<BasketRow[]>([]);
  const [releasing, setReleasing] = useState(false);
  const abort = useRef<AbortController | null>(null);
  // 무엇을 마지막으로 물었는지. 같은 것을 두 번 묻지 않게 한다.
  const asked = useRef("");

  const loadBasket = useCallback(async () => {
    try {
      setBasket((await api<{ items: BasketRow[] }>("/basket")).items);
    } catch {
      /* the basket is a convenience; a failed refresh must not take the search with it */
    }
  }, []);

  useEffect(() => {
    void loadBasket();
    // 처리 중인 항목이 있으면 상태가 바뀌는 것을 지켜본다.
    const timer = window.setInterval(() => void loadBasket(), 5_000);
    return () => window.clearInterval(timer);
  }, [loadBasket]);

  const runSearch = useCallback(async function runSearch(text: string, providers: ProviderId[]): Promise<void> {
    const wanted = text.trim();
    if (wanted.length === 0 || providers.length === 0) return;
    asked.current = `${wanted}\u0000${[...providers].sort().join(",")}`;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setSearching(true);
    setFailure("");
    setHits(null);
    try {
      const created = await api<{ id: string }>("/searches", {
        method: "POST",
        body: JSON.stringify({ query: wanted, kind: "song", providers }),
        signal: controller.signal,
      });
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if (controller.signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, 700));
        const status = await api<SearchState>(`/searches/${encodeURIComponent(created.id)}`, { signal: controller.signal });
        if (status.state === "done") {
          setHits(status.items ?? []);
          return;
        }
        if (status.state === "failed") throw new Error(status.error ?? "SEARCH_FAILED");
      }
      throw new Error("NO_COLLECTOR");
    } catch (reason) {
      if (controller.signal.aborted) return;
      const code = reason instanceof Error ? reason.message : "SEARCH_FAILED";
      setFailure(
        code === "NO_COLLECTOR"
          ? "응답한 Collector가 없습니다. 최소 한 대는 실행 중이어야 검색할 수 있습니다."
          : `검색에 실패했습니다 (${code})`,
      );
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }, []);

  /**
   * Search when typing stops.
   *
   * Every search sends a Collector to four or five services, so it waits for a pause rather
   * than firing per keystroke — fourteen characters cost one request, not fourteen. It also
   * refuses to repeat a question it has already asked, so a service switched off and back on
   * within the pause settles without spending anything.
   */
  useEffect(() => {
    const wanted = query.trim();
    const key = `${wanted}\u0000${[...chosen].sort().join(",")}`;
    if (wanted.length < 2) {
      // 빈 상자 아래 남은 결과는 무엇에 대한 답인지 알 수 없다.
      abort.current?.abort();
      asked.current = "";
      setHits(null);
      setFailure("");
      setSearching(false);
      return;
    }
    if (chosen.length === 0 || key === asked.current) return;
    const timer = window.setTimeout(() => void runSearch(query, chosen), 600);
    return () => window.clearTimeout(timer);
  }, [query, chosen, runSearch]);

  async function keep(hit: Hit): Promise<void> {
    try {
      await api("/basket", { method: "POST", body: JSON.stringify(hit) });
      await loadBasket();
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "담기에 실패했습니다", { variant: "error" });
    }
  }

  async function drop(id: string): Promise<void> {
    try {
      await api(`/basket/${encodeURIComponent(id)}`, { method: "DELETE" });
      setBasket((rows) => rows.filter((row) => row.id !== id));
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "삭제에 실패했습니다", { variant: "error" });
    }
  }

  async function process(): Promise<void> {
    setReleasing(true);
    try {
      const result = await api<{ released: number }>("/basket/process", { method: "POST", body: "{}" });
      showToast(`${result.released}곡을 Collector로 넘겼습니다.`);
      await loadBasket();
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "처리에 실패했습니다", { variant: "error" });
    } finally {
      setReleasing(false);
    }
  }

  const held = basket.filter((row) => row.state === "held").length;
  const kept = new Set(basket.map((row) => `${row.artist}\0${row.title}`));

  return (
    <div className="add-songs">
      <section className="detail-section">
        <div className="yt-search">
          <input
            className="form-control"
            placeholder="아티스트나 곡 이름으로 검색"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void runSearch(query, chosen);
            }}
            aria-label="곡 검색"
          />
          <button
            className="primary-button"
            onClick={() => void runSearch(query, chosen)}
            disabled={searching || query.trim().length === 0 || chosen.length === 0}
          >
            {searching ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
            검색
          </button>
        </div>
        <div className="provider-picks" role="group" aria-label="검색할 서비스">
          {PROVIDERS.map((provider) => {
            const on = chosen.includes(provider.id);
            return (
              <button
                key={provider.id}
                className={`provider-pick ${on ? "on" : ""}`}
                aria-pressed={on}
                onClick={() => setChosen((all) => (on ? all.filter((id) => id !== provider.id) : [...all, provider.id]))}
              >
                <img src={PROVIDER_ICONS[provider.id]} alt="" width={16} height={16} />
                {provider.label}
              </button>
            );
          })}
          <span className="provider-hint">
            {chosen.length === PROVIDERS.length
              ? "통합 검색"
              : chosen.length === 0
                ? "서비스를 하나 이상 고르세요"
                : `${chosen.length}개 서비스`}
          </span>
        </div>

        {failure !== "" && <p className="detail-note warn">{failure}</p>}
        {searching && <p className="detail-note">Collector가 검색하는 중입니다…</p>}

        {hits !== null && hits.length === 0 && <p className="filter-empty">검색 결과가 없습니다.</p>}
        {hits !== null && hits.length > 0 && (
          <div className="hit-list">
            {hits.map((hit) => {
              const already = kept.has(`${hit.artist}\0${hit.title}`);
              return (
                <div key={`${hit.artist}-${hit.title}`} className="hit-row">
                  {hit.artwork === undefined ? (
                    <span className="hit-art placeholder">
                      <Music size={16} />
                    </span>
                  ) : (
                    <img className="hit-art" src={hit.artwork} alt="" loading="lazy" />
                  )}
                  <div className="hit-main">
                    <strong>{hit.title}</strong>
                    <span>
                      {hit.artist}
                      {hit.album !== undefined && ` · ${hit.album}`}
                      {hit.duration_ms !== undefined && ` · ${clock(hit.duration_ms)}`}
                    </span>
                    <Badges providers={hit.providers} />
                  </div>
                  <button className={already ? "ghost-button" : "primary-button"} onClick={() => void keep(hit)} disabled={already}>
                    {already ? <Check size={14} /> : <Plus size={14} />}
                    {already ? "담김" : "담기"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="detail-section basket">
        <h3>
          <ShoppingBasket size={15} />
          장바구니 <b>{basket.length}</b>
        </h3>
        {basket.length === 0 ? (
          <p className="filter-empty">담은 곡이 없습니다. 검색해서 추가하세요.</p>
        ) : (
          <>
            <div className="hit-list">
              {basket.map((row) => (
                <div key={row.id} className={`hit-row ${row.state}`}>
                  <div className="hit-main">
                    <strong>{row.title}</strong>
                    <span>
                      {row.artist}
                      {row.album != null && ` · ${row.album}`}
                      {row.duration_ms != null && ` · ${clock(row.duration_ms)}`}
                      {row.isrc != null && ` · ${row.isrc}`}
                    </span>
                    <Badges providers={row.providers} />
                  </div>
                  <span className={`state-badge ${row.state === "failed" ? "bad" : "muted"}`}>
                    {/*
                      담긴 것과 넘긴 것은 다른 상태다 — 처리를 눌러야 Collector 가 가져간다.
                      모르는 상태를 실패로 읽으면 안 된다: 전송됨이 생겼을 때 옛 화면이 정상인 곡을
                      전부 실패로 보여줬다.
                    */}
                    {STATE_LABELS[row.state] ?? row.state}
                  </span>
                  {row.error != null && <code className="hit-error">{row.error}</code>}
                  <button className="icon-button" onClick={() => void drop(row.id)} aria-label={`${row.title} 빼기`} title="빼기">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
            <div className="basket-actions">
              <button className="primary-button" onClick={() => void process()} disabled={releasing || held === 0}>
                {releasing ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
                {held === 0 ? "넘길 곡 없음" : `${held}곡 처리`}
              </button>
              <span className="basket-hint">누르기 전까지는 담아둔 것뿐입니다. 누르면 Collector가 순서대로 가져갑니다.</span>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
