#!/usr/bin/env python3
"""
평가셋 한 조각을 처음부터 끝까지 처리한다 — 내려받고, 가르고, 듣고, 앵커를 센다.

--shard i/n 으로 곡을 나눠 GPU 마다 하나씩 띄운다. demucs 가 CPU 를 열댓 코어 쓰므로,
갈래 수는 GPU 수와 코어 수 중 작은 쪽에 맞춘다.

곡이 끝날 때마다 즉시 기록하고 이미 끝난 video_id 는 건너뛰므로, 중간에 끊겨도 이어서
돌리면 된다.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


def load_daemon(path: Path) -> Any:
    spec = importlib.util.spec_from_file_location("daemon", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def run(args: list[str]) -> None:
    # stdin 을 막지 않으면 ffmpeg 과 yt-dlp 가 부모의 입력을 먹는다.
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"{args[0]}: {result.stderr[-200:]}")


def stems(video_id: str, root: Path) -> Path:
    """보컬 스템까지 가는 길. 단계마다 이미 있으면 건너뛴다 — 다시 돌릴 때가 잦다."""
    place = root / video_id
    vocals = place / "htdemucs_ft" / "mixture" / "vocals.wav"
    if vocals.exists():
        return vocals
    place.mkdir(parents=True, exist_ok=True)
    source = next((q for q in place.glob("source.*") if q.suffix != ".part"), None)
    if source is None:
        run(["yt-dlp", "--js-runtimes", "node", "--no-playlist", "--no-write-info-json", "-f", "bestaudio/best",
             "-o", str(place / "source.%(ext)s"), f"https://music.youtube.com/watch?v={video_id}"])
        source = next(q for q in place.glob("source.*") if q.suffix != ".part")
    mixture = place / "mixture.wav"
    if not mixture.exists():
        run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", str(source),
             "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s24le", str(mixture)])
    run([sys.executable, "-m", "demucs", "-n", "htdemucs_ft", "--device", "cuda", "--out", str(place), str(mixture)])
    return vocals


def measure(daemon: Any, lyric: list[str], heard: list[dict[str, Any]]) -> tuple[int, int]:
    """앵커 수와, 앵커 없이 이어진 가장 긴 낱말 수."""
    placed = sorted(daemon.match_sequences(lyric, heard))
    if not placed:
        return 0, len(lyric)
    edges = [-1, *placed, len(lyric)]
    return len(placed), max(edges[i + 1] - edges[i] - 1 for i in range(len(edges) - 1))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--songs", default="songs_with_text.json", help="가사 본문이 들어 있는 곡 목록")
    parser.add_argument("--daemon", default="/workspace/Mora/Generator/python/mora_ml_daemon.py")
    parser.add_argument("--work", default="work", help="스템을 두는 곳")
    parser.add_argument("--out", default="results")
    parser.add_argument("--shard", default="0/1")
    args = parser.parse_args()

    daemon = load_daemon(Path(args.daemon))
    songs = json.loads(Path(args.songs).read_text(encoding="utf-8"))
    index, count = (int(part) for part in args.shard.split("/"))

    # 영상 기준으로 나눈다. 아티스트 표기만 다른 같은 곡이 두 레코딩으로 들어오는 일이
    # 있고, 곡 순서로 나누면 그 둘이 다른 갈래로 갈려 두 GPU 가 같은 디렉터리에 동시에
    # 내려받는다 — yt-dlp 가 임시 파일 이름을 바꾸다 충돌한다.
    videos = sorted({song["video_id"] for song in songs})
    mine = {video for rank, video in enumerate(videos) if rank % count == index}
    songs = [song for song in sorted(songs, key=lambda s: (s["video_id"], s["title"])) if song["video_id"] in mine]

    root, out = Path(args.work), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    report = out / f"shard{index}of{count}.jsonl"
    done = (
        {json.loads(line)["video_id"] for line in report.read_text(encoding="utf-8").splitlines() if line.strip()}
        if report.exists()
        else set()
    )
    print(f"[갈래 {index}/{count}] 곡 {len(songs)}개 · 이미 끝난 것 {len(done)}개", flush=True)

    for rank, song in enumerate(songs, 1):
        video_id = song["video_id"]
        if video_id in done:
            continue
        label = f"{song['artist'][:14]} - {song['title'][:18]}"
        began = time.time()

        def say(what: str) -> None:
            # 곡 하나가 두 시간의 절반쯤 걸린다. 끝날 때만 찍으면 멈춘 것과 구별되지 않는다.
            print(f"  [{rank}/{len(songs)}] {label:<34} {what}", flush=True)

        try:
            say("스템 있음" if (root / video_id / "htdemucs_ft" / "mixture" / "vocals.wav").exists() else "내려받고 가르는 중…")
            vocals = stems(video_id, root)
            lyric = [
                daemon.comparable(word)
                for line in song["text"].splitlines()
                if line.strip()
                for word in line.split()
                if daemon.comparable(word)
            ]
            language = (song.get("language") or "und").split("-")[0]

            say(f"기준선 받아쓰는 중… ({len(lyric)}낱말, {language})")
            base, _ = daemon.coarse_asr(vocals, language, "cuda")
            base_anchors, base_gap = measure(daemon, lyric, daemon.asr_words(base))

            say(f"기준선 앵커 {base_anchors} (빈 {base_gap}) · 여러 벌 듣는 중…")
            heard, _ = daemon.hear_everything(vocals, language, "cuda", lyric)
            anchors, gap = measure(daemon, lyric, daemon.asr_words(heard))

            row = {
                "video_id": video_id, "artist": song["artist"], "title": song["title"],
                "language": language, "words": len(lyric),
                "before_anchors": base_anchors, "before_gap": base_gap,
                "after_anchors": anchors, "after_gap": gap,
                "seconds": round(time.time() - began, 1),
            }
        except Exception as error:  # noqa: BLE001 — 한 곡이 죽어도 나머지는 돈다
            row = {"video_id": video_id, "artist": song["artist"], "title": song["title"],
                   "error": f"{type(error).__name__}: {error}"[:200]}

        with report.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        told = (
            f"앵커 {row['before_anchors']}→{row['after_anchors']} 빈 {row['before_gap']}→{row['after_gap']}  {row['seconds']}s"
            if "error" not in row
            else row["error"][:70]
        )
        print(f"  [{rank}/{len(songs)}] {label:<34} {told}", flush=True)

    print(f"[갈래 {index}/{count}] 끝 → {report}", flush=True)


if __name__ == "__main__":
    main()
