import { Ruler, TrendingDown, TrendingUp } from "lucide-react";
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

export function AccuracyView() {
  const [data, setData] = useState<Accuracy | null>(null);
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
          {data.songs.map((song) => (
            <tr key={song.video_id}>
              <td>
                <a href={`https://music.youtube.com/watch?v=${encodeURIComponent(song.video_id)}`} target="_blank" rel="noreferrer">
                  {song.artist} — {song.title}
                </a>
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
            </tr>
          ))}
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
