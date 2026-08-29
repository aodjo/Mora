#!/usr/bin/env python3
"""
LRCLIB 에서 긁은 곡에 유튜브 video_id 를 붙여 정답 파일로 만든다.

`korean.py` 는 아티스트·제목·줄 시각까지만 만든다. `measure.py` 는 video_id 로 음원을
받으므로 그 사이를 여기서 잇는다. 유튜브에 묻는 일은 음원을 받는 기계에서 하는 것이 맞다 —
집 아이피로 수십 번 두드릴 일이 아니고, 어차피 받는 것도 그 기계다.

받은 것이 그 곡이 맞는지는 **길이로 가린다.** 검색은 라이브·커버·리믹스를 곧잘 물어 오는데,
그것들은 원곡과 길이가 다르다. Collector 가 음원 후보를 고를 때 쓰는 문턱이 3 초이고
(`RECORDING_DRIFT_TOLERANCE_MS`), 실측으로 맞춘 값이라 여기서도 그것을 따른다. 다만 LRCLIB
길이는 업로더가 적은 것이라 우리 쪽보다 흐리므로 조금 넉넉히 둔다.

    python3 resolve.py --in korean-candidates.json --out /workspace/truth.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

# 빌린 기계에서는 저 자리에 있고, 다른 데서는 PATH 에 있다. 어느 쪽이든 --ytdlp 로 덮는다.
DEFAULT_YTDLP = os.getenv("MORA_YTDLP", "/workspace/Mora/Generator/.venv/bin/yt-dlp")


def search(ytdlp: str, artist: str, title: str, want: int) -> list[dict]:
    """유튜브에서 몇 건을 받아 온다. 내려받지 않고 정보만 본다.

    `--js-runtimes node` 는 노드가 있을 때만 넣는다. 없는 기계에서 그 깃발을 주면 yt-dlp 가
    시작도 못 한다 — 검색만 하는 이 자리에서는 대개 자바스크립트가 필요 없다.
    """
    command = [ytdlp, "--no-playlist", "--flat-playlist", "--skip-download", "--dump-json",
               "--ignore-errors"]
    if shutil.which("node"):
        command += ["--js-runtimes", "node"]
    command.append(f"ytsearch{want}:{artist} {title}")
    try:
        got = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True,
                             text=True, timeout=180)
    except subprocess.TimeoutExpired:
        return []
    rows = []
    for line in got.stdout.splitlines():
        try:
            rows.append(json.loads(line))
        except Exception:
            continue
    return rows


def bag(text: str) -> set[str]:
    """견줄 수 있는 조각들. 괄호 딸림말과 기호는 버린다."""
    text = re.sub(r"[\(（\[].*?[\)）\]]", " ", text.lower())
    return {piece for piece in re.split(r"[^0-9a-z가-힣]+", text) if len(piece) > 1}


def pick(rows: list[dict], song: dict, tolerance: float) -> dict | None:
    """길이가 맞고 이름도 겹치는 것.

    길이만으로 고르면 위험하다. LRCLIB 은 사람이 올린 것이라 아티스트·제목이 어긋난 항목이
    섞이고, 그 이름으로 검색하면 엉뚱한 곡이 나온다. 길이가 우연히 5 초 안에 들면 그대로
    통과해 **다른 곡의 가사로 우리 정렬을 재게 된다** — 그런 곡은 밀도가 0 에 가깝게 나와
    "정렬이 나쁘다"로 읽히지, "다른 곡을 받았다"로는 읽히지 않는다.

    그래서 이름도 본다. 유튜브 제목에 우리 아티스트나 제목의 조각이 하나도 없으면 버린다.
    """
    want = bag(song["artist"]) | bag(song["title"])
    best, best_gap = None, None
    for row in rows:
        length = row.get("duration")
        if not length or abs(length - song["duration"]) > tolerance:
            continue
        if want and not (want & (bag(row.get("title") or "") | bag(row.get("uploader") or ""))):
            continue
        gap = abs(length - song["duration"])
        if best_gap is None or gap < best_gap:
            best, best_gap = row, gap
    return best


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="source", default="korean-candidates.json")
    parser.add_argument("--out", default="/workspace/truth.json")
    parser.add_argument("--candidates", type=int, default=5, help="곡마다 몇 건을 보고 고를까")
    parser.add_argument("--tolerance", type=float, default=5.0, help="길이 차이 허용(초)")
    parser.add_argument("--ytdlp", default=DEFAULT_YTDLP)
    args = parser.parse_args()

    ytdlp = args.ytdlp if Path(args.ytdlp).exists() else (shutil.which("yt-dlp") or args.ytdlp)
    if not Path(ytdlp).exists() and shutil.which(ytdlp) is None:
        sys.exit(f"yt-dlp 를 찾을 수 없다: {ytdlp}")

    songs = json.loads(Path(args.source).read_text(encoding="utf-8"))
    truth, missed = [], []
    # 도중에 끊겨도 거둔 것은 남긴다. 빌린 기계든 남의 노트북이든 언제든 사라진다.
    partial = Path(args.out).with_suffix(".partial.json")
    for index, song in enumerate(songs, 1):
        rows = search(ytdlp, song["artist"], song["title"], args.candidates)
        best = pick(rows, song, args.tolerance)
        name = f"{song['artist'][:14]} - {song['title'][:26]}"
        if best is None:
            missed.append(song)
            near = min((abs((r.get("duration") or 0) - song["duration"]) for r in rows if r.get("duration")),
                       default=None)
            print(f"  {index:>3}/{len(songs)}  못 찾음  {name}"
                  f"{'' if near is None else f' (가장 가까운 것도 {near:.0f}초 차이)'}", flush=True)
            continue
        truth.append({
            "video_id": best["id"],
            "artist": song["artist"],
            "title": song["title"],
            "language": song["language"],
            "duration": song["duration"],
            "lines": song["lines"],
        })
        print(f"  {index:>3}/{len(songs)}  {best['id']}  {abs(best['duration'] - song['duration']):>4.1f}초 차이  {name}",
              flush=True)
        partial.write_text(json.dumps(truth, ensure_ascii=False), encoding="utf-8")

    Path(args.out).write_text(json.dumps(truth, ensure_ascii=False), encoding="utf-8")
    print(f"\n  정답 {len(truth)}곡 · 줄 {sum(len(t['lines']) for t in truth)}개 → {args.out}")
    print(f"  못 찾은 곡 {len(missed)}개")
    if not truth:
        sys.exit("붙인 곡이 없다")


if __name__ == "__main__":
    main()
