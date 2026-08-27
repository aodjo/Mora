#!/usr/bin/env python3
"""
우리 정렬이 실제로 몇 ms 틀리는가.

오늘 잰 것은 전부 대리 지표였다. 앵커 밀도는 "몇 낱말이 들렸나"이고 숨 자리는 "경계가 조용한
데 있나"다. 둘 다 "맞나"를 묻지 않는다. LRCLIB 의 줄 시각을 정답으로 놓으면 처음으로 물을 수
있다.

가사 줄도 LRCLIB 것을 그대로 쓴다. 우리 가사 시트를 쓰면 두 시트의 줄을 짝지어야 하고 —
줄 수가 다르고 머리글이 섞이고 후렴 반복이 어긋난다 — 그 짝짓기의 오류가 정렬의 오류와
섞여 버린다. 같은 줄을 넣고 같은 줄을 견주면 그 자리가 없다.

두 가지를 따로 적는다.
  * 날 오차 — 정답 시각과 우리 시각의 차이 그대로.
  * 치우침 뺀 오차 — 곡마다 가운뎃값만큼 통째로 민 뒤의 차이.
LRCLIB 시각은 공식 음원 기준이고 우리는 유튜브 것을 받는다. 인트로 길이가 다르면 곡 전체가
일정하게 밀리는데, 그것은 정렬의 잘못이 아니라 음원이 다른 것이다. 둘을 갈라야 어느 쪽이
문제인지 안다.
"""
from __future__ import annotations

import importlib.util
import json
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path

MORA = Path("/workspace/Mora")
spec = importlib.util.spec_from_file_location("daemon", MORA / "Generator/python/mora_ml_daemon.py")
daemon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(daemon)

WORK = Path("/workspace/measure")
PY = "/workspace/Mora/Generator/.venv/bin/python"
YTDLP = "/workspace/Mora/Generator/.venv/bin/yt-dlp"


def audio_for(video: str) -> Path | None:
    """받아서 보컬만 남긴다. 이미 있으면 그대로 쓴다."""
    out = WORK / video
    vocals = out / "demucs" / "htdemucs_ft" / "mixture" / "vocals.wav"
    if vocals.exists():
        return vocals
    out.mkdir(parents=True, exist_ok=True)
    source = next((p for p in out.glob("source.*") if p.suffix != ".part"), None)
    if source is None:
        subprocess.run([YTDLP, "--no-playlist", "--js-runtimes", "node", "-f", "bestaudio/best",
                        "--retries", "5", "-o", str(out / "source.%(ext)s"),
                        f"https://music.youtube.com/watch?v={video}"],
                       stdin=subprocess.DEVNULL, capture_output=True, timeout=600)
        source = next((p for p in out.glob("source.*") if p.suffix != ".part"), None)
    if source is None:
        return None
    mixture = out / "mixture.wav"
    if not mixture.exists():
        subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", str(source),
                        "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s24le", str(mixture)],
                       capture_output=True, timeout=600)
    if not vocals.exists():
        subprocess.run([PY, "-m", "demucs", "-n", "htdemucs_ft", "--device", "cuda",
                        "--out", str(out / "demucs"), str(mixture)], capture_output=True, timeout=1800)
    return vocals if vocals.exists() else None


def tokenized(text: str, language: str) -> list[dict]:
    """워커가 쓰는 그 토크나이저로 가른다.

    line.split() 으로 갈랐던 판이 있었다. 일본어는 띄어쓰기가 없어 한 줄이 낱말 하나가 되고,
    「怪獣」46 줄이 낱말 46 개가 되어 앵커가 붙을 자리 자체가 없었다 — 밀도 0.00 이 나왔고
    그것을 일본어의 성질로 읽을 뻔했다. worker.ts 의 주석이 바로 그것을 경고하고 있었다.
    """
    got = subprocess.run(["node", str(Path(__file__).with_name("tokenize.mjs"))],
                         input=json.dumps({"text": text, "language": language}),
                         capture_output=True, text=True, timeout=120)
    if got.returncode != 0:
        raise RuntimeError(f"tokenize.mjs: {got.stderr.strip()[:200]}")
    return json.loads(got.stdout)


def seconds_of(path: Path) -> float:
    got = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "csv=p=0", str(path)], capture_output=True, text=True)
    try:
        return float(got.stdout.strip())
    except ValueError:
        return 0.0


def main() -> None:
    truth = json.loads(Path(os.getenv("MORA_TRUTH", "/workspace/truth.json")).read_text(encoding="utf-8"))
    only = sys.argv[1:] or None
    results = []
    for song in truth:
        if only and song["video_id"] not in only:
            continue
        name = f"{song['artist']} - {song['title']}"
        began = time.time()
        vocals = audio_for(song["video_id"])
        if vocals is None:
            print(f"  ✖ {name[:40]} — 음원 못 받음", flush=True)
            continue

        rows = song["lines"]
        text = "\n".join(row["text"] for row in rows)
        language = str(song.get("language", "und"))
        token_lines = tokenized(text, language)
        if len(token_lines) != len(rows):
            # 줄 수가 어긋나면 우리 시각과 정답 시각을 줄 번호로 짝지을 수 없다. 억지로
            # 이으면 그 어긋남이 정렬 오차로 둔갑한다.
            print(f"  ✖ {name[:40]} — 토크나이저가 {len(token_lines)}줄, 정답은 {len(rows)}줄", flush=True)
            continue
        variant = {"id": "truth", "language": language, "text": text, "token_lines": token_lines}
        heard, detected = daemon.coarse_asr(vocals, language, "cuda")
        length_ms = int(seconds_of(vocals) * 1000)
        got = daemon.align_variant(vocals, variant, heard, length_ms, "cuda", detected)

        ours = [span[0] for span in got["line_spans"]]
        want = [row["at"] for row in rows]
        pairs = list(zip(ours, want))
        raw = [a - b for a, b in pairs]
        shift = statistics.median(raw)
        fixed = [value - shift for value in raw]

        quality = got["quality"]
        results.append({
            "name": name, "lines": len(rows),
            "raw_median": statistics.median([abs(v) for v in raw]),
            "shift": shift,
            "median": statistics.median([abs(v) for v in fixed]),
            "p90": sorted(abs(v) for v in fixed)[int(len(fixed) * 0.9)],
            "within300": sum(1 for v in fixed if abs(v) <= 300) / len(fixed),
            "density": quality.get("anchor_density", 0.0),
            "breath": quality.get("breath_gaps", 0.0),
            "lrclib_seconds": song.get("duration"), "our_seconds": length_ms / 1000,
        })
        print(f"  ✔ {name[:34]:<36}{len(rows):>3}줄  치우침 {shift / 1000:>+6.1f}s  "
              f"오차 {results[-1]['median']:>5.0f}ms  0.3초내 {results[-1]['within300']:>4.0%}  "
              f"밀도 {quality.get('anchor_density', 0):.2f}  ({time.time() - began:.0f}초)", flush=True)

    if not results:
        return
    print("\n  ── 전체 ──")
    print(f"  {'줄':>4}{'치우침':>9}{'오차중앙':>9}{'p90':>8}{'0.3초내':>8}{'밀도':>7}{'숨자리':>7}  곡")
    print("  " + "─" * 92)
    for row in sorted(results, key=lambda r: r["median"]):
        print(f"  {row['lines']:>4}{row['shift'] / 1000:>+8.1f}s{row['median']:>8.0f}ms{row['p90']:>7.0f}ms"
              f"{row['within300']:>8.0%}{row['density']:>7.2f}{row['breath']:>7.2f}  {row['name'][:30]}")
    medians = [r["median"] for r in results]
    print(f"\n  곡 {len(results)}개 · 오차 가운뎃값의 가운뎃값 {statistics.median(medians):.0f}ms")
    print(f"  0.3 초 안에 든 줄의 비율 (전곡 평균) {statistics.mean(r['within300'] for r in results):.0%}")
    # GPU 마다 하나씩 띄우면 두 판이 같은 파일에 쓴다 — 실측에서 절반을 잃었다.
    stamp = "-".join(sorted(only)[:1]) if only else "all"
    Path(f"/workspace/measure/result-{stamp}.json").write_text(
        json.dumps(results, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
