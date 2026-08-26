"""아홉 번째 칸 — 여덟 갈래를 한눈에."""
import json, time, glob, collections
from pathlib import Path

TOTAL = len(json.loads(Path("/workspace/songs.json").read_text(encoding="utf-8")))
while True:
    files = glob.glob("/workspace/hearing/*.json")
    ok, bad, secs = 0, [], []
    langs = collections.Counter()
    for f in files:
        try: r = json.loads(Path(f).read_text(encoding="utf-8"))
        except Exception: continue
        if "error" in r: bad.append(r)
        else:
            ok += 1; secs.append(r.get("seconds", 0)); langs[r.get("language", "?")] += 1
    done = ok + len(bad)
    rate = sum(secs) / len(secs) if secs else 0
    left = (TOTAL - done) * rate / 8 / 60 if rate else 0
    print("\033[2J\033[H", end="")
    print(f"  받아쓰기 캐시   {done}/{TOTAL}   성공 {ok} · 실패 {len(bad)}")
    print(f"  곡당 평균 {rate:>5.0f}초 · 남은 시간 약 {left:>4.0f}분")
    print(f"  언어  " + "  ".join(f"{k} {v}" for k, v in sorted(langs.items())))
    print()
    for f in sorted(glob.glob("/workspace/results_shard*.log"))[:0]: pass
    for r in bad[-6:]:
        print(f"  실패 {r['artist'][:16]:<18}{r['title'][:22]:<24}{str(r.get('error'))[:44]}")
    print(f"\n  {time.strftime('%H:%M:%S')}")
    time.sleep(15)
