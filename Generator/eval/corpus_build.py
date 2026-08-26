#!/usr/bin/env python3
"""
코퍼스 한 조각을 처음부터 끝까지 처리한다 — 내려받고, 가르고, 듣고, 앵커를 센다.

--shard i/n 으로 곡을 나눠 GPU 마다 하나씩 띄운다. demucs 는 CPU 를 15 코어쯤 쓰므로
192 코어면 네 갈래가 서로 방해하지 않는다.
"""
from __future__ import annotations
import argparse, importlib.util, json, os, subprocess, sys, time
from pathlib import Path

MORA = Path("/workspace/Mora")
spec = importlib.util.spec_from_file_location("daemon", MORA / "Generator/python/mora_ml_daemon.py")
daemon = importlib.util.module_from_spec(spec); spec.loader.exec_module(daemon)

p = argparse.ArgumentParser()
p.add_argument("--songs", default="/workspace/corpus.json")
p.add_argument("--work", default="/workspace/corpus")
p.add_argument("--out", default="/workspace/results")
p.add_argument("--shard", default="0/1")
a = p.parse_args()

songs = json.loads(Path(a.songs).read_text(encoding="utf-8"))
i, n = (int(x) for x in a.shard.split("/"))
# 영상 기준으로 나눈다. 같은 영상을 두 레코딩이 가리키는 일이 있고(아티스트 표기가 다른
# 같은 곡), 곡 순서로 나누면 그 둘이 다른 샤드로 갈려 두 GPU 가 같은 디렉터리에 동시에
# 내려받는다 — yt-dlp 가 이름을 바꾸다 충돌한다.
videos = sorted({s["video_id"] for s in songs})
mine = {v for k, v in enumerate(videos) if k % n == i}
songs = [s for s in sorted(songs, key=lambda s: (s["video_id"], s["title"])) if s["video_id"] in mine]
root, out = Path(a.work), Path(a.out); out.mkdir(parents=True, exist_ok=True)
report = out / f"shard{i}of{n}.jsonl"
done = {json.loads(l)["video_id"] for l in report.read_text(encoding="utf-8").splitlines() if l.strip()} if report.exists() else set()

def run(args):
    r = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if r.returncode != 0: raise RuntimeError(f"{args[0]}: {r.stderr[-200:]}")

def stem(vid):
    place = root / vid; vocals = place / "htdemucs_ft" / "mixture" / "vocals.wav"
    if vocals.exists(): return vocals
    place.mkdir(parents=True, exist_ok=True)
    src = next((q for q in place.glob("source.*") if q.suffix != ".part"), None)
    if src is None:
        run(["yt-dlp","--js-runtimes","node","--no-playlist","--no-write-info-json","-f","bestaudio/best",
             "-o",str(place/"source.%(ext)s"),f"https://music.youtube.com/watch?v={vid}"])
        src = next(q for q in place.glob("source.*") if q.suffix != ".part")
    mix = place/"mixture.wav"
    if not mix.exists():
        run(["ffmpeg","-nostdin","-y","-loglevel","error","-i",str(src),"-vn","-ac","2","-ar","44100","-c:a","pcm_s24le",str(mix)])
    run([sys.executable,"-m","demucs","-n","htdemucs_ft","--device","cuda","--out",str(place),str(mix)])
    return vocals

print(f"[샤드 {i}/{n}] 곡 {len(songs)}개, 완료 {len(done)}개", flush=True)
for k, song in enumerate(songs, 1):
    vid = song["video_id"]
    if vid in done:
        continue
    label = f"{song['artist'][:14]} - {song['title'][:18]}"
    began = time.time()
    def say(what):
        print(f"  [{k}/{len(songs)}] {label:<34} {what}", flush=True)
    try:
        cached = (root / vid / "htdemucs_ft" / "mixture" / "vocals.wav").exists()
        say("스템 있음" if cached else "내려받고 가르는 중…")
        vocals = stem(vid)
        lines = [l for l in song["text"].splitlines() if l.strip()]
        words = [daemon.comparable(w) for l in lines for w in l.split() if daemon.comparable(w)]
        native = (song.get("language") or "und").split("-")[0]
        say(f"기준선 받아쓰는 중… ({len(words)}낱말, {native})")
        base, _ = daemon.coarse_asr(vocals, native, "cuda")
        b_n, b_gap = stats(words, daemon.asr_words(base)) if False else (0, 0)
        anchors = daemon.match_sequences(words, daemon.asr_words(base))
        placed = sorted(anchors)
        b_gap = max([-1, *placed, len(words)][j+1] - [-1, *placed, len(words)][j] - 1 for j in range(len(placed)+1)) if placed else len(words)
        b_n = len(anchors)
        say(f"기준선 앵커 {b_n} (빈 {b_gap}) · 8벌 듣는 중…")
        asr, _ = daemon.hear_everything(vocals, native, "cuda", words)
        anchors = daemon.match_sequences(words, daemon.asr_words(asr))
        placed = sorted(anchors)
        a_gap = max([-1, *placed, len(words)][j+1] - [-1, *placed, len(words)][j] - 1 for j in range(len(placed)+1)) if placed else len(words)
        a_n = len(anchors)
        row = {"video_id": vid, "artist": song["artist"], "title": song["title"], "language": native,
               "latin": song["latin_share"], "words": len(words),
               "before_anchors": b_n, "before_gap": b_gap, "after_anchors": a_n, "after_gap": a_gap,
               "before_reach": round(max(0.0, 1-b_gap/40), 3), "after_reach": round(max(0.0, 1-a_gap/40), 3),
               "seconds": round(time.time()-began, 1)}
    except Exception as e:
        row = {"video_id": vid, "artist": song["artist"], "title": song["title"], "error": f"{type(e).__name__}: {e}"[:200]}
    with report.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    mark = f"앵커 {row.get('before_anchors','?')}→{row.get('after_anchors','?')} 빈 {row.get('before_gap','?')}→{row.get('after_gap','?')}" if "error" not in row else row["error"][:60]
    print(f"  [{k}/{len(songs)}] {label:<34} {mark}  {row.get('seconds','?')}s", flush=True)
print(f"[샤드 {i}/{n}] 끝 -> {report}", flush=True)
