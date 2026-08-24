import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { api } from "./api";
import { useToast } from "./Toast";
import { linesOverWords, onlyTheFloor } from "./confidence.js";
import { pushNeighbours } from "./edit.js";
import { cursorSpan, isAside, type WordSpan } from "./cursor.js";
import { Timeline } from "./Timeline.js";

type Span = [number, number];
interface ReviewToken {
  index: number;
  text: string;
  line: number;
  speaker_id: number | null;
  speaker_confidence: number | null;
}
interface ReviewLine {
  index: number;
  text: string;
  token_indices: number[];
}
interface Artifact {
  id: string;
  kind: string;
  speaker_id: number | null;
  content_type: string;
  byte_size: number;
}
interface Detail {
  id: string;
  job_id: string;
  recording: { artist: string; title: string };
  variant: { provider: string; language: string; layer: string };
  lyric_text: string;
  tokens: ReviewToken[];
  lines: ReviewLine[];
  line_spans: Span[];
  word_spans: WordSpan[];
  artifacts: Artifact[];
  draft: { word_spans: WordSpan[]; saved_at: number } | null;
}

const trackNames: Record<string, string> = {
  source: "원본",
  vocals: "보컬",
  drums: "드럼",
  bass: "베이스",
  other: "기타 반주",
  speaker: "화자",
};
const speakerColors = ["#0070f3", "#7928ca", "#eb367f", "#ab570a", "#0c8c72", "#c50000"];

/** A line that is nothing but a bracketed aside — the second voice, sung over its neighbour. */
export function Editor({ candidateId, onPublished }: { candidateId: string; onPublished?: () => void }) {
  const { showToast } = useToast();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [dirty, setDirty] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [message, setMessage] = useState("");
  const [currentMs, setCurrentMs] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [regenerating, setRegenerating] = useState(false);
  const [resumed, setResumed] = useState<number | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [lyricsOpen, setLyricsOpen] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(false);
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());
  const playingId = useRef<string | null>(null);
  const volumeSet = useRef(new Set<string>());
  const lineRefs = useRef(new Map<number, HTMLDivElement>());
  useEffect(() => {
    void api<Detail>(`/candidates/${candidateId}`)
      .then((loaded) => {
        // 저장해 둔 초안이 있으면 그것이 지금 고치던 상태다. 생성값을 보여 주면
        // 다음 자동 저장이 그 위를 덮어 앞서 고친 것이 사라진다.
        if (loaded.draft === null) return setDetail(loaded);
        setResumed(loaded.draft.saved_at);
        setDetail({
          ...loaded,
          word_spans: loaded.draft.word_spans,
          line_spans: linesOverWords(loaded.draft.word_spans, loaded.lines, loaded.line_spans),
        });
      })
      .catch((reason: unknown) =>
        showToast(reason instanceof Error ? reason.message : "편집기를 불러오지 못했습니다.", { variant: "error" }),
      );
    void api(`/candidates/${candidateId}/lease`, { method: "POST", body: "{}" }).catch((reason: unknown) =>
      showToast(reason instanceof Error ? reason.message : "편집 권한을 얻지 못했습니다.", { variant: "error" }),
    );
  }, [candidateId, showToast]);
  useEffect(() => {
    if (!dirty || detail === null) return;
    const timer = window.setTimeout(() => {
      void api(`/candidates/${candidateId}/draft`, {
        method: "PUT",
        body: JSON.stringify({
          line_spans: linesOverWords(detail.word_spans, detail.lines, detail.line_spans),
          word_spans: detail.word_spans,
        }),
      })
        .then(() => {
          setDirty(false);
          setDraftSaved(true);
          setMessage("초안 저장됨");
          showToast("타이밍 초안을 자동 저장했습니다.");
        })
        .catch((reason: unknown) => showToast(reason instanceof Error ? reason.message : "타이밍 초안 저장 실패", { variant: "error" }));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [candidateId, detail, dirty, showToast]);
  // 토큰 번호로 표의 몇 번째 줄인지. change() 는 배열 위치로 고치므로 이 표가 필요하다.
  const rowOf = useMemo(() => new Map((detail?.word_spans ?? []).map((span, index) => [span[0], index])), [detail]);
  const order = useMemo(() => (detail?.word_spans ?? []).map((span) => span[0]), [detail]);
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      // 입력칸이나 오디오에 초점이 있으면 그쪽이 임자다 — 숫자를 치다 스크럽되면 안 된다.
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "AUDIO" || target?.isContentEditable) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // 한글 자판에서 event.key 는 "ㅔ"/"ㅐ" 가 된다. 물리 키로 본다.
      if (event.code === "Space") {
        // 브라우저 기본 동작은 화면을 아래로 굴리는 것이다.
        event.preventDefault();
        const track = trackToToggle();
        if (track === undefined) return;
        if (track.paused) void track.play().catch(() => showToast("재생하지 못했습니다.", { variant: "error" }));
        else track.pause();
        return;
      }
      const step = event.shiftKey ? 200 : 20;
      const at = chosen === null ? null : rowOf.get(chosen);
      if (event.code === "Tab") {
        event.preventDefault();
        const place = chosen === null ? -1 : order.indexOf(chosen);
        const next = order[Math.min(order.length - 1, Math.max(0, place + (event.shiftKey ? -1 : 1)))];
        if (next !== undefined) {
          setChosen(next);
          const span = spans.get(next);
          if (span !== undefined) seek(Math.max(0, span[1] - 400));
        }
        return;
      }
      if (event.code === "KeyN") {
        event.preventDefault();
        const suspects = order.filter((token) => rescued.has(token));
        const after = suspects.find((token) => chosen === null || order.indexOf(token) > order.indexOf(chosen)) ?? suspects[0];
        if (after !== undefined) {
          setChosen(after);
          const span = spans.get(after);
          if (span !== undefined) seek(Math.max(0, span[1] - 400));
        }
        return;
      }
      if (at === undefined || at === null) return;
      const span = detail?.word_spans[at];
      if (span === undefined) return;
      // 아직 아무것도 재생하지 않았으면 재생 위치는 0 이다. 그걸 경계로 찍으면 낱말이
      // 곡 맨 앞으로 날아간다 — 들으면서 쓰라고 있는 키다.
      if ((event.code === "BracketLeft" || event.code === "BracketRight") && currentMs <= 0) {
        event.preventDefault();
        showToast("재생한 뒤에 눌러 주세요 — 재생 위치를 경계로 찍는 키입니다.", { variant: "error" });
        return;
      }
      if (event.code === "BracketLeft") {
        event.preventDefault();
        change(at, 1, Math.min(Math.round(currentMs), span[2] - 20));
      } else if (event.code === "BracketRight") {
        event.preventDefault();
        change(at, 2, Math.max(Math.round(currentMs), span[1] + 20));
      } else if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
        event.preventDefault();
        const by = event.code === "ArrowLeft" ? -step : step;
        change(at, 1, Math.max(0, span[1] + by));
        change(at, 2, Math.max(span[1] + by + 20, span[2] + by));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const [peaks, setPeaks] = useState<number[] | null>(null);
  useEffect(() => {
    const drawn = detail?.artifacts.find((artifact) => artifact.kind === "waveform");
    if (drawn === undefined) return setPeaks(null);
    // 곡마다 이미 만들어 올려 두는 값이다. 읽기만 하면 된다.
    void api<number[]>(`/artifacts/${drawn.id}/content`)
      .then((values) => setPeaks(Array.isArray(values) ? values : null))
      .catch(() => setPeaks(null));
  }, [detail]);
  const playableArtifacts = useMemo(() => detail?.artifacts.filter((artifact) => canPlay(artifact.content_type)) ?? [], [detail]);
  const unsupportedCount = (detail?.artifacts.length ?? 0) - playableArtifacts.length;
  const duration = useMemo(
    () => Math.max(1, mediaDuration, ...(detail?.line_spans.map((span) => span[1]) ?? [1])),
    [detail, mediaDuration],
  );
  const spans = useMemo(() => new Map(detail?.word_spans.map((span) => [span[0], span]) ?? []), [detail]);
  const tokens = useMemo(() => new Map(detail?.tokens.map((token) => [token.index, token]) ?? []), [detail]);
  // 괄호로만 된 줄은 옆줄 위에 겹쳐 부르는 두 번째 목소리다. 그 시간은 옆줄의 시간과
  // 겹치는 것이 맞지만, 커서는 하나뿐이라 둘 다 가질 수 없다. 커서는 리드를 따라간다.
  const asideLines = useMemo(() => new Set((detail?.lines ?? []).filter((line) => isAside(line.text)).map((line) => line.index)), [detail]);
  // 겹친 구간에서 토큰 순서상 첫 번째를 고르면, 앞줄이 커서를 붙들고 있다가 다음 줄
  // 한가운데로 건너뛴다 — 화면에서는 가사가 뒤까지 찼다가 앞으로 되돌아가는 것으로 보인다.
  // 시작한 것 중 가장 마지막 것을 고르면 커서는 시간과 함께만 움직인다.
  const activeSpan = cursorSpan(detail?.word_spans ?? [], currentMs, (index) => asideLines.has(tokens.get(index)?.line ?? -1));
  // 정렬기가 눌러 놓은 낱말은 바닥값만 받는다 — 잰 것이 아니라 구해 준 것이다. 스쳐 지나가
  // 눈에 안 띄므로, 어느 것이 그런지 먼저 보이게 한다.
  const rescued = useMemo(
    () =>
      new Set(
        (detail?.word_spans ?? []).filter((span) => onlyTheFloor(tokens.get(span[0])?.text ?? "", span[1], span[2])).map((span) => span[0]),
      ),
    [detail, tokens],
  );
  const activeToken = activeSpan?.[0] ?? null;
  const activeLine = activeToken === null ? null : (tokens.get(activeToken)?.line ?? null);
  useEffect(() => {
    if (activeLine !== null) lineRefs.current.get(activeLine)?.scrollIntoView({ block: "nearest" });
  }, [activeLine]);
  if (detail === null) return <p className="loading-copy">편집기를 불러오는 중…</p>;
  const jobId = detail.job_id;

  function change(index: number, field: 1 | 2, value: number): void {
    setDetail((current) =>
      current === null
        ? current
        : {
            ...current,
            word_spans: current.word_spans.map((span, spanIndex) =>
              spanIndex === index ? [span[0], field === 1 ? value : span[1], field === 2 ? value : span[2]] : span,
            ),
          },
    );
    setDirty(true);
    setDraftSaved(false);
    setMessage("편집 중");
  }
  /** 낱말을 옮기고, 겹친 이웃은 그만큼 먹힌다. 한 줄에서 두 낱말이 동시에 불릴 수는 없다. */
  function moveWord(row: number, startMs: number, endMs: number): void {
    setDetail((current) => {
      if (current === null) return current;
      const moved = current.word_spans.map((span, index) => (index === row ? ([span[0], startMs, endMs] as WordSpan) : span));
      const lineOf = (token: number): number | undefined => current.tokens.find((entry) => entry.index === token)?.line;
      return { ...current, word_spans: pushNeighbours(moved, row, lineOf) };
    });
    setDirty(true);
    setDraftSaved(false);
    setMessage("편집 중");
  }
  function seek(milliseconds: number): void {
    setCurrentMs(milliseconds);
    // 재생 중인 것만 옮긴다. 전부 옮기면 스템 하나하나에 복호화 구간 요청이 나간다.
    const listening = playingId.current === null ? undefined : audioRefs.current.get(playingId.current);
    if (listening !== undefined) listening.currentTime = milliseconds / 1000;
    else for (const audio of audioRefs.current.values()) audio.currentTime = milliseconds / 1000;
  }
  /**
   * Space 로 재생·정지할 트랙.
   *
   * 스템이 여럿이라 "지금 곡" 이라는 것이 하나로 정해져 있지 않다. 듣고 있던 것이 있으면
   * 그것, 없으면 원본 — 검수하는 사람이 먼저 트는 것이 원본이다.
   */
  function trackToToggle(): HTMLAudioElement | undefined {
    const listening = playingId.current === null ? undefined : audioRefs.current.get(playingId.current);
    if (listening !== undefined) return listening;
    const source = playableArtifacts.find((artifact) => artifact.kind === "source") ?? playableArtifacts[0];
    return source === undefined ? undefined : audioRefs.current.get(source.id);
  }
  function play(id: string, element: HTMLAudioElement): void {
    for (const [otherId, audio] of audioRefs.current) if (otherId !== id) audio.pause();
    playingId.current = id;
    setCurrentMs(element.currentTime * 1000);
  }

  return (
    <div className="editor-layout">
      <section className="editor-panel">
        <div className="editor-title">
          <div>
            <h2>{detail.recording.title}</h2>
            <p>
              {detail.recording.artist} · {detail.variant.provider} · {detail.variant.language.toUpperCase()}
            </p>
          </div>
          <span className="save-state">{message}</span>
        </div>
        {resumed !== null && (
          <div className="resumed-banner">
            <span>이어서 편집 중 · {new Date(resumed).toLocaleString("ko-KR")}에 저장한 초안입니다</span>
            <button
              type="button"
              onClick={() => {
                void api(`/candidates/${candidateId}/draft`, { method: "DELETE" })
                  .then(() => {
                    setResumed(null);
                    setDirty(false);
                    return api<Detail>(`/candidates/${candidateId}`).then(setDetail);
                  })
                  .then(() => showToast("생성된 타이밍으로 되돌렸습니다."))
                  .catch((reason: unknown) =>
                    showToast(reason instanceof Error ? reason.message : "되돌리지 못했습니다.", { variant: "error" }),
                  );
              }}
            >
              생성값으로 되돌리기
            </button>
          </div>
        )}
        <div className="editor-keys">
          <span>
            <kbd>Space</kbd> 재생·정지
          </span>
          <span>
            <kbd>Tab</kbd> 다음 낱말
          </span>
          <span>
            <kbd>N</kbd> 다음 의심 낱말
          </span>
          <span>
            <kbd>[</kbd> <kbd>]</kbd> 재생 위치를 시작·끝으로
          </span>
          <span>
            <kbd>←</kbd> <kbd>→</kbd> 20ms 밀기 (<kbd>Shift</kbd> 200ms)
          </span>
        </div>
        <div className="editor-section-heading">
          <h3>검수 오디오</h3>
          <span>
            {formatTime(currentMs)} / {formatTime(duration)}
          </span>
        </div>
        <div className="audio-tracks">
          {playableArtifacts.map((artifact) => (
            <div key={artifact.id} className="artifact-row">
              <span>{trackName(artifact)}</span>
              <audio
                ref={(element) => {
                  if (element === null) return void audioRefs.current.delete(artifact.id);
                  audioRefs.current.set(artifact.id, element);
                  // 처음 한 번만 낮춰 둔다. 이 ref 는 그릴 때마다 다시 불리므로, 매번 맞추면
                  // 검수하는 사람이 올려 둔 소리를 그릴 때마다 도로 내려 버린다.
                  if (!volumeSet.current.has(artifact.id)) {
                    volumeSet.current.add(artifact.id);
                    element.volume = 0.6;
                  }
                }}
                controls
                preload="metadata"
                src={`/admin/api/generator/artifacts/${artifact.id}/content`}
                onPlay={(event) => play(artifact.id, event.currentTarget)}
                onTimeUpdate={(event) => setCurrentMs(event.currentTarget.currentTime * 1000)}
                onSeeked={(event) => setCurrentMs(event.currentTarget.currentTime * 1000)}
                onLoadedMetadata={(event) => {
                  const loadedDuration = event.currentTarget.duration * 1000;
                  setMediaDuration((current) => Math.max(current, loadedDuration));
                }}
              />
            </div>
          ))}
        </div>
        {playableArtifacts.length === 0 && (
          <p className="editor-notice">재생 가능한 검수 오디오가 없습니다. 이 작업을 다시 생성해야 합니다.</p>
        )}
        {unsupportedCount > 0 && (
          <div className="editor-notice">
            <span>현재 브라우저가 지원하지 않는 이전 형식 트랙 {unsupportedCount}개는 숨겼습니다.</span>
            <button disabled={regenerating} onClick={() => void regenerate()}>
              {regenerating ? "요청 중…" : "호환 오디오 다시 생성"}
            </button>
          </div>
        )}
        <Timeline
          peaks={peaks}
          durationMs={duration}
          currentMs={currentMs}
          words={detail.word_spans}
          tokens={tokens}
          lines={detail.lines}
          lineSpans={linesOverWords(detail.word_spans, detail.lines, detail.line_spans)}
          asideLines={asideLines}
          rescued={rescued}
          chosen={chosen}
          onChoose={setChosen}
          onSeek={seek}
          onMove={(row, startMs, endMs) => moveWord(row, Math.round(startMs), Math.round(endMs))}
        />
      </section>

      <section className="lyrics-review-panel">
        <button
          type="button"
          className="editor-section-heading editor-fold"
          aria-expanded={lyricsOpen}
          onClick={() => setLyricsOpen((open) => !open)}
        >
          <div className="fold-lead">
            <span className={`fold-mark${lyricsOpen ? " open" : ""}`} aria-hidden="true" />
            <div>
              <h3>가사와 문장 타이밍</h3>
              <p>문장이나 단어를 누르면 해당 위치로 이동합니다.</p>
            </div>
          </div>
          <span>
            {detail.lines.length}문장 · {detail.tokens.length}단어
          </span>
        </button>
        <div className="lyrics-lines" hidden={!lyricsOpen}>
          {detail.lines.map((line) => {
            const lineSpans = line.token_indices.flatMap((index) => {
              const span = spans.get(index);
              return span === undefined ? [] : [span];
            });
            const start = Math.min(...lineSpans.map((span) => span[1]));
            const end = Math.max(...lineSpans.map((span) => span[2]));
            return (
              <div
                key={line.index}
                ref={(element) => {
                  if (element === null) lineRefs.current.delete(line.index);
                  else lineRefs.current.set(line.index, element);
                }}
                className={`lyric-line${activeLine === line.index ? " active" : ""}`}
              >
                <button className="line-time" disabled={!Number.isFinite(start)} onClick={() => seek(start)}>
                  {Number.isFinite(start) ? formatTime(start) : "--:--"}
                </button>
                <div>
                  <p>{line.text}</p>
                  <div className="lyric-tokens">
                    {line.token_indices.map((index) => {
                      const token = tokens.get(index);
                      const span = spans.get(index);
                      return (
                        <button
                          key={index}
                          disabled={span === undefined}
                          className={`${activeToken === index ? "active " : ""}${chosen === index ? "chosen " : ""}${span === undefined ? "unmapped" : rescued.has(index) ? "rescued" : ""}`}
                          title={rescued.has(index) ? "정렬기가 재지 못해 최소 길이만 준 낱말" : undefined}
                          style={{ "--speaker-color": speakerColor(token?.speaker_id) } as CSSProperties}
                          onClick={() => {
                            setChosen(index);
                            if (span !== undefined) seek(span[1]);
                          }}
                        >
                          <span>{token?.text ?? index}</span>
                          {token?.speaker_id === null || token?.speaker_id === undefined ? null : (
                            <small>화자 {token.speaker_id + 1}</small>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {Number.isFinite(end) && (
                    <span className="line-range">
                      {formatTime(start)}–{formatTime(end)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <div className="editor-table-wrap">
        <table className="editor-table">
          <thead>
            <tr>
              <th>#</th>
              <th>가사</th>
              <th>화자</th>
              <th>시작 ms</th>
              <th>종료 ms</th>
            </tr>
          </thead>
          <tbody>
            {detail.word_spans.map((span, index) => {
              const token = tokens.get(span[0]);
              return (
                <tr
                  key={index}
                  className={`${activeToken === span[0] ? "active " : ""}${chosen === span[0] ? "chosen " : ""}${rescued.has(span[0]) ? "rescued" : ""}`}
                  onClick={() => setChosen(span[0])}
                >
                  <td>{span[0]}</td>
                  <td className="token-text">{token?.text ?? "—"}</td>
                  <td>{token?.speaker_id === null || token?.speaker_id === undefined ? "—" : `화자 ${token.speaker_id + 1}`}</td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="10"
                      value={span[1]}
                      onChange={(event) => change(index, 1, Number(event.target.value))}
                      className="timing-input"
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="10"
                      value={span[2]}
                      onChange={(event) => change(index, 2, Number(event.target.value))}
                      className="timing-input"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="editor-actions">
        <div className="editor-publish-note">
          <strong>이 후보를 공개할까요?</strong>
          <p>
            승인하면 지금 보고 있는 타이밍이 공개 API와 주간 덤프에 즉시 반영됩니다. 편집한 내용을 반영하려면 먼저 검수 리비전을 제출하고 새
            후보를 승인하세요.
          </p>
        </div>
        <button disabled={!draftSaved || dirty || publishing} onClick={() => void submitDraft()} className="secondary-button">
          검수 리비전 제출
        </button>
        <button disabled={dirty || publishing || published} onClick={() => void approve()} className="primary-button">
          {published ? "게시 완료" : publishing ? "게시 중…" : "승인하고 공개 게시"}
        </button>
      </div>
    </div>
  );

  async function submitDraft(): Promise<void> {
    try {
      await api(`/candidates/${candidateId}/submit-draft`, { method: "POST", body: "{}" });
      setDraftSaved(false);
      setMessage("새 후보 리비전 제출됨");
      showToast("검수 리비전을 제출했습니다.");
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "검수 리비전 제출 실패", { variant: "error" });
    }
  }
  async function approve(): Promise<void> {
    if (
      !window.confirm(
        `"${detail?.recording.title ?? "이 후보"}"의 타이밍을 공개 게시합니다. 공개 API에 즉시 반영되며, 되돌리려면 릴리스 화면에서 철회해야 합니다. 계속할까요?`,
      )
    )
      return;
    setPublishing(true);
    try {
      await api(`/candidates/${candidateId}/approve`, { method: "POST", body: "{}" });
      setPublished(true);
      setMessage("공개 게시됨");
      showToast("후보를 승인하고 공개 게시했습니다.");
      onPublished?.();
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "후보 승인 실패", { variant: "error" });
    } finally {
      setPublishing(false);
    }
  }
  async function regenerate(): Promise<void> {
    setRegenerating(true);
    try {
      await api(`/jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST", body: "{}" });
      showToast("AAC 호환 오디오 재생성 작업을 큐에 넣었습니다.");
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : "오디오 재생성 요청 실패", { variant: "error" });
    } finally {
      setRegenerating(false);
    }
  }
}

function canPlay(contentType: string): boolean {
  if (typeof document === "undefined") return false;
  const probe = document.createElement("audio");
  const type = contentType === "audio/ogg" ? 'audio/ogg; codecs="opus"' : contentType;
  return probe.canPlayType(type) !== "";
}
function trackName(artifact: Artifact): string {
  return `${trackNames[artifact.kind] ?? artifact.kind}${artifact.speaker_id === null ? "" : ` ${artifact.speaker_id + 1}`}`;
}
function speakerColor(speaker: number | null | undefined): string {
  return speaker === null || speaker === undefined ? "#8f8f8f" : (speakerColors[speaker % speakerColors.length] ?? "#8f8f8f");
}
function formatTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
