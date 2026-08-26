#!/usr/bin/env python3
"""
곡마다 벌별 받아쓰기를 통째로 저장한다. 듣는 일은 여기서 한 번만 한다.

지금까지는 질문 하나마다 처음부터 다시 들었다 — 합의 문턱을 바꿔 보려고 곡당 100 초,
어느 벌이 기여하는지 보려고 또 100 초. 답이 나올 때마다 다음 질문이 생기므로 끝이 없다.

받아쓰기 결과는 질문과 무관하다. 한 번 듣고 낱말 목록을 그대로 남겨 두면, 합의 문턱도
벌 조합도 순서 처리도 전부 CPU 에서 즉시 쓸어볼 수 있다. 비싼 일은 한 번만 한다.

한 곡의 산출물:
  hearing/<video_id>.json
    lyric    : 비교용으로 정규화한 가사 낱말
    batches  : {벌 이름: [{word, start, end}, …]}   ← 시각은 원본 기준으로 되돌려 놓은 것
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
import tempfile
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
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"{args[0]}: {result.stderr[-200:]}")


def stems(video_id: str, root: Path, proxy: str | None) -> Path:
    place = root / video_id
    vocals = place / "htdemucs_ft" / "mixture" / "vocals.wav"
    if vocals.exists():
        return vocals
    place.mkdir(parents=True, exist_ok=True)
    source = next((q for q in place.glob("source.*") if q.suffix != ".part"), None)
    if source is None:
        run(["yt-dlp", "--js-runtimes", "node", "--no-playlist", "--no-write-info-json", "-f", "bestaudio/best",
             *(["--proxy", proxy] if proxy else []),
             "-o", str(place / "source.%(ext)s"), f"https://music.youtube.com/watch?v={video_id}"])
        source = next(q for q in place.glob("source.*") if q.suffix != ".part")
    mixture = place / "mixture.wav"
    if not mixture.exists():
        run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", str(source),
             "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s24le", str(mixture)])
    run([sys.executable, "-m", "demucs", "-n", "htdemucs_ft", "--device", "cuda", "--out", str(place), str(mixture)])
    return vocals


def hear_every_way(daemon: Any, vocals: Path, language: str, say: Any) -> dict[str, list[dict[str, Any]]]:
    """원본, 영어로 한 번 더, 그리고 피치·속도를 바꾼 벌들. 시각은 전부 원본 기준으로 되돌린다."""
    batches: dict[str, list[dict[str, Any]]] = {}

    say("원본 듣는 중…")
    native, _ = daemon.coarse_asr(vocals, language, "cuda")
    batches["원본"] = daemon.asr_words(native)

    # 한국어·일본어 곡의 영어 구절은 그 언어 모델이 잘 못 듣는다. 영어로 한 번 더 듣는다.
    if language not in ("en", "und"):
        say("영어로 듣는 중…")
        english, _ = daemon.coarse_asr(vocals, "en", "cuda")
        batches["영어"] = daemon.asr_words(english)

    with tempfile.TemporaryDirectory() as scratch:
        for name, filters, factor in daemon.AUGMENTS:
            say(f"{name} 듣는 중…")
            clip = Path(scratch) / f"{name}.wav"
            made = subprocess.run(
                ["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", str(vocals), "-af", filters, str(clip)],
                stdin=subprocess.DEVNULL, capture_output=True,
            )
            if made.returncode != 0:
                continue
            heard, _ = daemon.coarse_asr(clip, language, "cuda")
            # 속도를 바꾼 벌은 시각이 늘거나 줄어 있다. 되돌려 놓아야 다른 벌과 견줄 수 있다.
            batches[name] = daemon.asr_words(daemon.rescale_segments(heard, factor))
    return batches


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--songs", default="/workspace/songs.json")
    parser.add_argument("--daemon", default="/workspace/Mora/Generator/python/mora_ml_daemon.py")
    parser.add_argument("--work", default="/workspace/audio")
    parser.add_argument("--out", default="/workspace/hearing")
    parser.add_argument("--shard", default="0/1")
    parser.add_argument("--proxy", default=None, help="yt-dlp 가 나갈 때 거칠 곳")
    args = parser.parse_args()

    daemon = load_daemon(Path(args.daemon))
    songs = json.loads(Path(args.songs).read_text(encoding="utf-8"))
    index, count = (int(part) for part in args.shard.split("/"))

    # 영상 기준으로 나눈다 — 같은 영상을 두 레코딩이 가리키면 두 GPU 가 같은 곳에 내려받는다.
    videos = sorted({song["video_id"] for song in songs})
    mine = {video for rank, video in enumerate(videos) if rank % count == index}
    songs = [s for s in sorted(songs, key=lambda s: (s["video_id"], s["title"])) if s["video_id"] in mine]

    root, out = Path(args.work), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    todo = [s for s in songs if not (out / f"{s['video_id']}.json").exists()]
    print(f"[갈래 {index}/{count}] 곡 {len(songs)}개 · 남은 것 {len(todo)}개", flush=True)

    for rank, song in enumerate(todo, 1):
        video_id = song["video_id"]
        label = f"{song['artist'][:14]} - {song['title'][:18]}"
        began = time.time()

        def say(what: str) -> None:
            print(f"  [{rank}/{len(todo)}] {label:<34} {what}", flush=True)

        try:
            say("스템 있음" if (root / video_id / "htdemucs_ft" / "mixture" / "vocals.wav").exists() else "내려받고 가르는 중…")
            vocals = stems(video_id, root, args.proxy)
            lyric = [
                daemon.comparable(word)
                for line in song["text"].splitlines()
                if line.strip()
                for word in line.split()
                if daemon.comparable(word)
            ]
            language = (song.get("language") or "und").split("-")[0]
            batches = hear_every_way(daemon, vocals, language, say)
            payload = {
                "video_id": video_id, "artist": song["artist"], "title": song["title"],
                "language": language, "lyric": lyric,
                # asr_words 가 내는 열쇠는 text 다. 이 목록은 그대로 match_sequences 에 다시
                # 먹일 것이므로 이름을 바꾸지 않는다.
                "batches": {
                    name: [{"text": w["text"], "start": round(float(w["start"]), 3), "end": round(float(w["end"]), 3)}
                           for w in words]
                    for name, words in batches.items()
                },
                "seconds": round(time.time() - began, 1),
            }
            (out / f"{video_id}.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            counts = " ".join(f"{n}:{len(w)}" for n, w in batches.items())
            print(f"  [{rank}/{len(todo)}] {label:<34} 저장 · {len(lyric)}낱말 · {counts}  {payload['seconds']}s", flush=True)
        except Exception as error:  # noqa: BLE001
            # 내려받기 실패는 곡의 성질이 아니라 그때의 사정이다 — 통로가 끊겼거나 YouTube 가
            # 막았거나. 그것을 파일로 남기면 다시 돌릴 때 건너뛰어, 통로를 고쳐 놓고도 그 곡은
            # 영영 오지 않는다. 남기지 않으면 다음 회차가 알아서 다시 집는다.
            passing = isinstance(error, RuntimeError) and "yt-dlp" in str(error)
            if not passing:
                (out / f"{video_id}.json").write_text(
                    json.dumps({"video_id": video_id, "artist": song["artist"], "title": song["title"],
                                "error": f"{type(error).__name__}: {error}"[:300]}, ensure_ascii=False), encoding="utf-8")
            mark = "못 받음(다시 시도됨)" if passing else f"실패 {type(error).__name__}"
            print(f"  [{rank}/{len(todo)}] {label:<34} {mark}: {str(error)[:60]}", flush=True)

    print(f"[갈래 {index}/{count}] 끝", flush=True)


if __name__ == "__main__":
    main()
