#!/usr/bin/env python3
"""
낱말이 실제로 몇 ms 틀리는가.

measure.py 는 줄의 시작만 잰다. LRCLIB 이 줄 단위 시각밖에 주지 않아서였다 — 82 곡을 다
뒤졌을 때 낱말 단위가 있는 곡은 한 곡도 없었다. 그래서 word_spans 는 여태 한 번도 재어진 적이
없고, 앵커 밀도가 그 자리를 대신 지키고 있었다. 밀도는 "몇 낱말이 들려서 자리를 잡았나"를
말할 뿐 "그 자리가 맞나"는 말하지 않는다.

JamendoLyrics 는 낱말마다 시작과 끝을 준다 — 79 곡 21,580 낱말이고 오디오까지 CC 로 함께
온다. 한국어는 없으므로 이 자로 알 수 있는 것은 "우리 정렬기가 낱말을 제자리에 놓는가"이지
"한국 노래에서 잘 되는가"가 아니다. 뒤엣것은 손으로 맞춘 한국어 정답이 생겨야 답할 수 있다.

    git clone --depth 1 https://github.com/f90/jamendolyrics /workspace/jamendo
    python3 Generator/eval/words.py --dataset /workspace/jamendo [곡이름 …]
"""
from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import statistics
import subprocess
import sys
import time
from pathlib import Path

def find_daemon() -> Path:
    """이 파일이 저장소 밖으로 복사되어 돌 때가 있다. 상대 경로를 박아 두면 그때 깨진다."""
    here = Path(__file__).resolve()
    for parent in [*here.parents, Path("/workspace/Mora"), Path.cwd()]:
        candidate = parent / "Generator/python/mora_ml_daemon.py"
        if candidate.exists():
            return candidate
    raise SystemExit("mora_ml_daemon.py 를 못 찾았다")


spec = importlib.util.spec_from_file_location("daemon", find_daemon())
daemon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(daemon)

LANGUAGE = {"English": "en", "German": "de", "Spanish": "es", "French": "fr"}


def tokenized(text: str, language: str) -> list[dict]:
    """워커가 쓰는 그 토크나이저로 가른다 — 여기서 달리 가르면 재는 의미가 없다."""
    bridge = next((p for p in (Path(__file__).with_name("tokenize.mjs"),
                               find_daemon().parents[1] / "eval/tokenize.mjs") if p.exists()), None)
    if bridge is None:
        raise SystemExit("tokenize.mjs 를 못 찾았다")
    got = subprocess.run(["node", str(bridge)],
                         input=json.dumps({"text": text, "language": language}),
                         capture_output=True, text=True, timeout=120)
    if got.returncode != 0:
        raise RuntimeError(f"tokenize.mjs: {got.stderr.strip()[:200]}")
    return json.loads(got.stdout)


def separate(mp3: Path, work: Path) -> Path | None:
    vocals = work / "demucs" / "htdemucs_ft" / mp3.stem / "vocals.wav"
    if vocals.exists():
        return vocals
    work.mkdir(parents=True, exist_ok=True)
    mixture = work / f"{mp3.stem}.wav"
    if not mixture.exists():
        subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", str(mp3),
                        "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s24le", str(mixture)],
                       capture_output=True, timeout=600)
    subprocess.run([sys.executable, "-m", "demucs", "-n", "htdemucs_ft", "--device", "cuda",
                    "--out", str(work / "demucs"), str(mixture)], capture_output=True, timeout=1800)
    return vocals if vocals.exists() else None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="/workspace/jamendo")
    parser.add_argument("--work", default="/workspace/words")
    parser.add_argument("songs", nargs="*", help="Filepath 의 앞부분. 비우면 전부")
    args = parser.parse_args()

    root = Path(args.dataset)
    rows = list(csv.DictReader((root / "JamendoLyrics.csv").open(encoding="utf-8")))
    if args.songs:
        rows = [r for r in rows if any(r["Filepath"].startswith(s) for s in args.songs)]

    results = []
    for row in rows:
        stem = Path(row["Filepath"]).stem
        began = time.time()
        mp3 = root / "mp3" / row["Filepath"]
        truth_file = root / "annotations" / "words" / f"{stem}.csv"
        lyric_file = root / "lyrics" / f"{stem}.txt"
        if not (mp3.exists() and truth_file.exists() and lyric_file.exists()):
            print(f"  ✖ {stem[:40]} — 자료가 모자람", flush=True)
            continue

        truth = [(float(w["word_start"]), float(w["word_end"]))
                 for w in csv.DictReader(truth_file.open(encoding="utf-8"))]
        language = LANGUAGE.get(row["Language"], "en")
        text = lyric_file.read_text(encoding="utf-8")
        token_lines = tokenized(text, language)
        ours_count = sum(len(line["words"]) for line in token_lines)
        if ours_count != len(truth):
            # 낱말 수가 다르면 번호로 짝지을 수 없다. 억지로 이으면 그 어긋남이 정렬 오차로
            # 둔갑한다 — 줄 단위를 잴 때 같은 자리에서 한 번 속았다.
            print(f"  ✖ {stem[:40]} — 낱말 {ours_count} vs 정답 {len(truth)}", flush=True)
            continue

        vocals = separate(mp3, Path(args.work) / stem)
        if vocals is None:
            print(f"  ✖ {stem[:40]} — 목소리를 못 갈랐다", flush=True)
            continue

        heard, detected = daemon.coarse_asr(vocals, language, "cuda")
        length_ms = int(truth[-1][1] * 1000) + 5000
        variant = {"id": stem, "language": language, "text": text, "token_lines": token_lines}
        got = daemon.align_variant(vocals, variant, heard, length_ms, "cuda", detected)

        # word_spans 는 [토큰번호, 시작ms, 끝ms, 확신]. 번호로 정답과 짝짓는다.
        ours = {int(w[0]): (float(w[1]), float(w[2])) for w in got["word_spans"]}
        starts, ends = [], []
        for index, (want_start, want_end) in enumerate(truth):
            if index not in ours:
                continue
            starts.append(ours[index][0] - want_start * 1000)
            ends.append(ours[index][1] - want_end * 1000)
        if not starts:
            print(f"  ✖ {stem[:40]} — 짝지을 낱말이 없다", flush=True)
            continue

        shift = statistics.median(starts)
        fixed = [abs(v - shift) for v in starts]
        results.append({
            "song": f"{row['Artist']} - {row['Title']}", "language": language,
            "words": len(starts), "shift_ms": shift,
            "start_median_ms": statistics.median(fixed),
            "start_p90_ms": sorted(fixed)[int(len(fixed) * 0.9)],
            "within_100": sum(1 for v in fixed if v <= 100) / len(fixed),
            "within_300": sum(1 for v in fixed if v <= 300) / len(fixed),
            "end_median_ms": statistics.median(abs(v - shift) for v in ends),
            "density": got["quality"].get("anchor_density", 0.0),
        })
        # 곡마다 남긴다. 끝나고 한 번에 쓰면 기계가 사라질 때 그 판이 통째로 날아간다 —
        # 실제로 쉰다섯 곡을 그렇게 잃을 뻔했고, 로그를 긁어 겨우 복구했다.
        out = Path(args.work)
        out.mkdir(parents=True, exist_ok=True)
        (out / "words-partial.json").write_text(json.dumps(results, ensure_ascii=False), encoding="utf-8")
        last = results[-1]
        print(f"  ✔ {last['song'][:34]:<36}{last['words']:>5}낱말  치우침 {shift / 1000:>+5.1f}s  "
              f"시작오차 {last['start_median_ms']:>5.0f}ms  0.1초내 {last['within_100']:>4.0%}  "
              f"밀도 {last['density']:.2f}  ({time.time() - began:.0f}초)", flush=True)

    if not results:
        return
    print("\n  ── 전체 ──")
    print(f"  곡 {len(results)} · 낱말 {sum(r['words'] for r in results)}")
    print(f"  시작 오차 가운뎃값 {statistics.median(r['start_median_ms'] for r in results):.0f}ms")
    print(f"  0.1 초 안에 든 낱말 {statistics.mean(r['within_100'] for r in results):.0%} · "
          f"0.3 초 안 {statistics.mean(r['within_300'] for r in results):.0%}")
    Path(args.work).mkdir(parents=True, exist_ok=True)
    out = Path(args.work) / f"words-{results[0]['song'][:8].replace('/', '_')}.json"
    out.write_text(json.dumps(results, ensure_ascii=False), encoding="utf-8")
    print(f"  {out}")


if __name__ == "__main__":
    main()
