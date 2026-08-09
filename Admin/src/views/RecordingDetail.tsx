import { ArrowLeft, Check, ExternalLink, Play, Search, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useToast } from "../Toast";
import { number, parseObject, text, time, type AdminItem } from "./utils";

interface Detail {
  recording: AdminItem;
  sources: AdminItem[];
  revisions: AdminItem[];
}

interface SearchHit {
  video_id: string;
  title: string;
  channel: string;
  duration_ms: number;
  thumbnail: string;
}

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * How far the upload runs from the length the catalogue gives for this ISRC. It is the one
 * number that separates the recording from its music video, so it is stated in words rather
 * than left for the reviewer to subtract.
 */
function drift(catalogueMs: number, videoMs: number): { label: string; tone: "good" | "warn" | "bad" } | null {
  if (catalogueMs < 1 || videoMs < 1) return null;
  const gap = Math.abs(catalogueMs - videoMs);
  if (gap <= 2_000) return { label: `길이 일치 (${(gap / 1000).toFixed(1)}초 차)`, tone: "good" };
  if (gap <= 10_000) return { label: `${(gap / 1000).toFixed(1)}초 차이`, tone: "warn" };
  return { label: `${Math.round(gap / 1000)}초 차이`, tone: "bad" };
}

/** The iframe is created only when asked for, so a page of results is a page of images. */
function Player({ videoId, title }: { videoId: string; title: string }) {
  const [playing, setPlaying] = useState(false);
  if (playing)
    return (
      <iframe
        className="yt-frame"
        src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=1&rel=0`}
        title={title}
        allow="autoplay; encrypted-media"
        allowFullScreen
      />
    );
  return (
    <button type="button" className="yt-thumb" onClick={() => setPlaying(true)} aria-label={`${title} 재생`}>
      <img src={`https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/mqdefault.jpg`} alt="" loading="lazy" />
      <span>
        <Play size={16} fill="currentColor" />
      </span>
    </button>
  );
}

export function RecordingDetail({ recordingId, onBack, refresh }: { recordingId: string; onBack: () => void; refresh: () => void }) {
  const { showToast } = useToast();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<Detail>(`/recordings/${encodeURIComponent(recordingId)}`)
      .then((value) => {
        setDetail(value);
        setQuery((current) => (current.length > 0 ? current : `${text(value.recording.artist)} ${text(value.recording.title)}`.trim()));
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "곡 정보를 불러오지 못했습니다"));
  }, [recordingId]);
  useEffect(load, [load]);

  if (error !== "")
    return (
      <div className="empty-panel">
        <TriangleAlert size={20} />
        <strong>{error}</strong>
        <button className="secondary-button" onClick={onBack}>
          <ArrowLeft size={13} />곡 목록으로
        </button>
      </div>
    );
  if (detail === null) return <div className="skeleton-block" style={{ height: 320 }} />;

  const recording = detail.recording;
  const catalogueMs = number(recording.duration_ms);
  // 소스를 확정할 수 있는 리비전은 아직 작업이 없는 draft 하나다.
  const draft = detail.revisions.find((item) => text(item.state) === "draft" && item.job_id == null);
  const draftId = draft === undefined ? null : text(draft.id);
  const hasIsrc = text(recording.isrc).length > 0;
  const hasLyrics = draft !== undefined && number(draft.lyrics_count) > 0;
  const canSelect = draftId !== null && hasIsrc && hasLyrics;
  const blockedReason = !hasIsrc
    ? "ISRC가 없어 작업을 만들 수 없습니다. 소스 검수 화면에서 먼저 입력하세요."
    : draftId === null
      ? "이미 작업이 만들어져 소스를 바꿀 수 없습니다."
      : !hasLyrics
        ? "전처리된 가사가 없습니다. 소스 검수 화면에서 먼저 입력하세요."
        : "";

  async function choose(value: { source_id: string } | { url: string }): Promise<void> {
    if (draftId === null) return;
    setBusy(true);
    try {
      await api(`/source-reviews/${encodeURIComponent(draftId)}/select`, { method: "POST", body: JSON.stringify(value) });
      showToast("음원을 확정하고 Generator 작업을 생성했습니다.");
      load();
      refresh();
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "음원 확정 실패", { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function runSearch(): Promise<void> {
    if (query.trim().length === 0) return;
    setSearching(true);
    setSearchError("");
    try {
      const found = await api<{ items: SearchHit[] }>(`/youtube/search?q=${encodeURIComponent(query.trim())}`);
      setHits(found.items);
    } catch (reason) {
      const code = reason instanceof Error ? reason.message : "";
      setSearchError(
        code === "YOUTUBE_KEY_MISSING"
          ? "YouTube Data API 키가 설정되지 않았습니다. 권한·설정에서 등록하면 여기서 바로 검색할 수 있습니다."
          : code === "YOUTUBE_SEARCH_FAILED"
            ? "YouTube 검색에 실패했습니다. 일일 할당량을 넘었을 수 있습니다."
            : "YouTube 검색에 실패했습니다.",
      );
      setHits(null);
    } finally {
      setSearching(false);
    }
  }

  const selected = detail.sources.find((source) => source.selected === 1);
  const candidates = detail.sources.filter((source) => source.selected !== 1);

  return (
    <div className="recording-detail">
      <header className="detail-head">
        <button className="secondary-button" onClick={onBack}>
          <ArrowLeft size={13} />
          목록
        </button>
        <div>
          <h2>{text(recording.title, "제목 없음")}</h2>
          <p>
            {text(recording.artist, "아티스트 미상")} · {text(recording.album, "앨범 정보 없음")}
          </p>
        </div>
        <dl className="detail-facts">
          <div>
            <dt>길이</dt>
            <dd>{clock(catalogueMs)}</dd>
          </div>
          <div>
            <dt>ISRC</dt>
            <dd>{text(recording.isrc, "—")}</dd>
          </div>
          <div>
            <dt>수집</dt>
            <dd>{time(recording.created_at)}</dd>
          </div>
        </dl>
      </header>

      {blockedReason !== "" && (
        <p className="detail-note">
          <TriangleAlert size={13} />
          {blockedReason}
        </p>
      )}

      <section className="detail-section">
        <h3>확정된 음원</h3>
        {selected === undefined ? (
          <p className="detail-empty">아직 확정된 음원이 없습니다. 아래 후보에서 고르거나 직접 검색해 지정하세요.</p>
        ) : (
          <SourceRow source={selected} catalogueMs={catalogueMs} canSelect={false} busy={busy} onChoose={choose} confirmed />
        )}
      </section>

      <section className="detail-section">
        <h3>수집된 후보 {candidates.length > 0 && <b>{candidates.length}</b>}</h3>
        {candidates.length === 0 ? (
          <p className="detail-empty">Collector가 찾은 후보가 없습니다.</p>
        ) : (
          candidates.map((source) => (
            <SourceRow
              key={text(source.id)}
              source={source}
              catalogueMs={catalogueMs}
              canSelect={canSelect && !busy}
              busy={busy}
              onChoose={choose}
            />
          ))
        )}
      </section>

      <section className="detail-section">
        <h3>YouTube에서 직접 찾기</h3>
        <div className="yt-search">
          <input
            className="form-control"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void runSearch();
            }}
            placeholder="곡 이름과 아티스트"
          />
          <button className="secondary-button" onClick={() => void runSearch()} disabled={searching || query.trim().length === 0}>
            <Search size={13} />
            {searching ? "검색 중" : "검색"}
          </button>
          <a
            className="secondary-button"
            href={`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={13} />
            YouTube에서 열기
          </a>
        </div>
        {searchError !== "" && (
          <p className="detail-note">
            <TriangleAlert size={13} />
            {searchError}
          </p>
        )}
        {hits !== null &&
          (hits.length === 0 ? (
            <p className="detail-empty">검색 결과가 없습니다.</p>
          ) : (
            hits.map((hit) => {
              const gap = drift(catalogueMs, hit.duration_ms);
              return (
                <div key={hit.video_id} className="source-row">
                  <Player videoId={hit.video_id} title={hit.title} />
                  <div className="source-row-main">
                    <strong>{hit.title}</strong>
                    <span>
                      {hit.channel}
                      {hit.duration_ms > 0 && ` · ${clock(hit.duration_ms)}`}
                    </span>
                    {gap !== null && <em className={`drift ${gap.tone}`}>{gap.label}</em>}
                  </div>
                  <button
                    className="primary-button"
                    disabled={!canSelect || busy}
                    onClick={() => void choose({ url: `https://music.youtube.com/watch?v=${hit.video_id}` })}
                  >
                    <Check size={13} />이 음원으로
                  </button>
                </div>
              );
            })
          ))}
      </section>
    </div>
  );
}

function SourceRow({
  source,
  catalogueMs,
  canSelect,
  busy,
  onChoose,
  confirmed = false,
}: {
  source: AdminItem;
  catalogueMs: number;
  canSelect: boolean;
  busy: boolean;
  onChoose: (value: { source_id: string }) => void;
  confirmed?: boolean;
}) {
  const metadata = parseObject(source.metadata);
  const videoId = text(source.video_id);
  const title = text(metadata.title, `YouTube ${videoId}`);
  const gap = drift(catalogueMs, number(source.duration_ms) || number(metadata.duration_ms));
  return (
    <div className={`source-row ${confirmed ? "confirmed" : ""}`}>
      <Player videoId={videoId} title={title} />
      <div className="source-row-main">
        <strong>{title}</strong>
        <span>
          {text(source.artist, text(metadata.artist, "채널 정보 없음"))}
          {source.official === 1 && " · 아티스트 채널"}
          {number(source.score) > 0 && ` · ${Math.round(number(source.score) * 100)}점`}
        </span>
        {gap !== null && <em className={`drift ${gap.tone}`}>{gap.label}</em>}
        <a href={text(source.url)} target="_blank" rel="noreferrer">
          {text(source.url)}
          <ExternalLink size={10} />
        </a>
      </div>
      {confirmed ? (
        <span className="state-badge good">확정됨</span>
      ) : (
        <button className="primary-button" disabled={!canSelect || busy} onClick={() => onChoose({ source_id: text(source.id) })}>
          <Check size={13} />이 음원으로
        </button>
      )}
    </div>
  );
}
