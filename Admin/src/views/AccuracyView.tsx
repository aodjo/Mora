import { ChevronDown, ChevronRight, Ruler, TrendingDown, TrendingUp } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { relativeTime } from "./utils";

interface EvalSong {
  video_id: string;
  artist: string;
  title: string;
  language: string;
  lines: number;
  shift_ms: number;
  median_error_ms: number;
  p90_error_ms: number;
  within_300_share: number;
  anchor_density: number;
  breath_gaps: number;
}

interface EvalRun {
  id: string;
  pipeline_version: string;
  truth_source: string;
  songs: number;
  median_error_ms: number;
  within_300_share: number;
  note: string | null;
  created_at: number;
}

interface EvalLine {
  line_index: number;
  text: string;
  ours_ms: number;
  truth_ms: number;
}

interface Accuracy {
  run: EvalRun | null;
  songs: EvalSong[];
  history: Array<Pick<EvalRun, "id" | "pipeline_version" | "songs" | "median_error_ms" | "within_300_share" | "created_at">>;
}

/**
 * 0.3 초는 사람이 어긋남을 알아채기 시작하는 자리다. 이 색은 그 기준 하나로 정한다 —
 * 밀도나 점수처럼 여러 잣대를 섞으면 무엇을 보고 있는지 알 수 없게 된다.
 */
function tone(errorMs: number): "good" | "warn" | "bad" {
  if (errorMs <= 300) return "good";
  if (errorMs <= 1000) return "warn";
  return "bad";
}

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * 한 곡의 줄을 펼쳐 놓고 우리 자리와 정답을 나란히 보여 준다.
 *
 * "오차 가운뎃값 146ms" 만으로는 맞는지 알 수 없다. 어느 줄을 어디에 놓았고 정답은 어디였는지가
 * 보여야 사람이 판단할 수 있고, 유튜브 링크가 그 자리에서 열려야 귀로도 확인할 수 있다.
 *
 * 곡 전체가 일정하게 밀린 양(치우침)은 빼고 보여 준다. 그것은 유튜브 음원과 공식 음원의 인트로
 * 차이라 정렬의 잘못이 아니고, 빼지 않으면 모든 줄이 똑같이 틀린 것처럼 보인다.
 */
function Lines({ videoId, shiftMs }: { videoId: string; shiftMs: number }) {
  const [lines, setLines] = useState<EvalLine[] | null>(null);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    api<{ lines: EvalLine[] }>(`/eval/${encodeURIComponent(videoId)}/lines`)
      .then((got) => setLines(got.lines))
      .catch((reason) => setFailure(reason instanceof Error ? reason.message : "줄을 불러오지 못했습니다"));
  }, [videoId]);
  if (failure !== "") return <p className="detail-note warn">{failure}</p>;
  if (lines === null) return <p className="detail-empty">불러오는 중…</p>;
  if (lines.length === 0) return <p className="detail-note">이 곡은 줄별 기록이 없습니다. 다시 재면 함께 쌓입니다.</p>;
  return (
    <table className="accuracy-lines">
      <thead>
        <tr>
          <th>줄</th>
          <th>가사</th>
          <th>우리</th>
          <th>정답</th>
          <th>차이</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => {
          const gap = Math.round(line.ours_ms - line.truth_ms - shiftMs);
          return (
            <tr key={line.line_index}>
              <td className="figure">{line.line_index + 1}</td>
              <td className="lyric">{line.text}</td>
              <td className="figure">
                <a
                  href={`https://music.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${Math.max(0, Math.floor(line.truth_ms / 1000) - 1)}`}
                  target="_blank"
                  rel="noreferrer"
                  title="이 자리에서 듣기"
                >
                  {clock(line.ours_ms)}
                </a>
              </td>
              <td className="figure">{clock(line.truth_ms)}</td>
              <td className={`figure ${tone(Math.abs(gap))}`}>
                {gap > 0 ? "+" : ""}
                {gap}ms
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function AccuracyView() {
  const [data, setData] = useState<Accuracy | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [failure, setFailure] = useState("");

  useEffect(() => {
    api<Accuracy>("/eval")
      .then(setData)
      .catch((reason) => setFailure(reason instanceof Error ? reason.message : "불러오지 못했습니다"));
  }, []);

  if (failure !== "") return <p className="detail-note warn">{failure}</p>;
  if (data === null) return <p className="detail-empty">불러오는 중…</p>;
  if (data.run === null)
    return (
      <div className="empty-panel">
        <Ruler size={20} />
        <strong>아직 잰 적이 없습니다</strong>
        <p>
          <code>Generator/eval/measure.py</code> 로 정답셋을 돌리면 그 결과가 여기에 쌓입니다. 앵커 밀도와 숨 자리는 후보마다 붙지만
          그것들은 대리 지표이고, 실제 오차는 정답과 견줘야만 나옵니다.
        </p>
      </div>
    );

  const run = data.run;
  const previous = data.history[1];
  const moved = previous === undefined ? null : run.median_error_ms - previous.median_error_ms;

  return (
    <div className="accuracy">
      <div className="accuracy-band">
        <div className="accuracy-figure">
          <span className="accuracy-label">오차 가운뎃값</span>
          <strong className={tone(run.median_error_ms)}>{run.median_error_ms}ms</strong>
          {moved !== null && moved !== 0 && (
            <span className={`accuracy-move ${moved < 0 ? "good" : "bad"}`}>
              {moved < 0 ? <TrendingDown size={13} /> : <TrendingUp size={13} />}
              {moved > 0 ? "+" : ""}
              {moved}ms
            </span>
          )}
        </div>
        <div className="accuracy-figure">
          <span className="accuracy-label">0.3초 안에 든 줄</span>
          <strong>{Math.round(run.within_300_share * 100)}%</strong>
        </div>
        <div className="accuracy-figure">
          <span className="accuracy-label">잰 곡</span>
          <strong>{run.songs}</strong>
        </div>
        <div className="accuracy-meta">
          <span>{relativeTime(run.created_at)}</span>
          <code>{run.pipeline_version.slice(0, 12)}</code>
          <span>정답 {run.truth_source}</span>
        </div>
      </div>

      {/* 자의 한계를 화면에 적어 둔다. 이 숫자를 처음 보는 사람이 26ms 를 절대 정확도로 읽으면 안 된다. */}
      <p className="detail-note">
        정답은 사람이 손으로 찍은 줄 단위 싱크라 그 자체가 ±수백 ms 흔들립니다. 믿을 수 있는 것은 곡 사이의 견줌과 판 사이의 변화이지 절대
        정확도가 아닙니다. 낱말 단위 정답은 아직 없습니다.
      </p>

      <table className="accuracy-table">
        <thead>
          <tr>
            <th>곡</th>
            <th>언어</th>
            <th>줄</th>
            <th>오차</th>
            <th>p90</th>
            <th>0.3초내</th>
            <th>밀도</th>
            <th>숨 자리</th>
            <th>치우침</th>
          </tr>
        </thead>
        <tbody>
          {data.songs.flatMap((song) => [
            <tr key={song.video_id} className="accuracy-row" onClick={() => setOpen(open === song.video_id ? null : song.video_id)}>
              <td>
                <span className="accuracy-open">
                  {open === song.video_id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  {song.artist} — {song.title}
                </span>
              </td>
              <td>{song.language}</td>
              <td className="figure">{song.lines}</td>
              <td className={`figure ${tone(song.median_error_ms)}`}>{song.median_error_ms}ms</td>
              <td className="figure">{song.p90_error_ms}ms</td>
              <td className="figure">{Math.round(song.within_300_share * 100)}%</td>
              <td className="figure">{song.anchor_density.toFixed(2)}</td>
              <td className="figure">{song.breath_gaps.toFixed(2)}</td>
              {/* 곡 전체가 일정하게 밀린 양. 크면 정렬이 아니라 다른 음원을 받은 것이다. */}
              <td className={`figure ${Math.abs(song.shift_ms) > 3000 ? "warn" : ""}`}>
                {song.shift_ms > 0 ? "+" : ""}
                {(song.shift_ms / 1000).toFixed(1)}s
              </td>
            </tr>,
            ...(open === song.video_id
              ? [
                  <tr key={`${song.video_id}-lines`}>
                    <td colSpan={9} className="accuracy-detail">
                      <Lines videoId={song.video_id} shiftMs={song.shift_ms} />
                    </td>
                  </tr>,
                ]
              : []),
          ])}
        </tbody>
      </table>

      {data.history.length > 1 && (
        <div className="accuracy-history">
          <h3>지난 판</h3>
          <table className="accuracy-table">
            <thead>
              <tr>
                <th>잰 때</th>
                <th>파이프라인</th>
                <th>곡</th>
                <th>오차</th>
                <th>0.3초내</th>
              </tr>
            </thead>
            <tbody>
              {data.history.map((past) => (
                <tr key={past.id}>
                  <td>{relativeTime(past.created_at)}</td>
                  <td>
                    <code>{past.pipeline_version.slice(0, 12)}</code>
                  </td>
                  <td className="figure">{past.songs}</td>
                  <td className={`figure ${tone(past.median_error_ms)}`}>{past.median_error_ms}ms</td>
                  <td className="figure">{Math.round(past.within_300_share * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
