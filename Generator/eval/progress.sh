#!/usr/bin/env bash
cd /workspace
python3 - <<'PY'
import json, glob
rows = [json.loads(l) for f in glob.glob("results/shard*.jsonl") for l in open(f, encoding="utf-8") if l.strip()]
ok = [r for r in rows if "error" not in r]
bad = [r for r in rows if "error" in r]
print(f"완료 {len(rows)}/83  (성공 {len(ok)} · 실패 {len(bad)})")
if ok:
    better = sum(1 for r in ok if r["after_gap"] < r["before_gap"])
    worse = sum(1 for r in ok if r["after_gap"] > r["before_gap"])
    print(f"  빈 구간이 줄어든 곡 {better} · 늘어난 곡 {worse} · 같음 {len(ok)-better-worse}")
    print(f"  평균 최장 빈 구간  {sum(r['before_gap'] for r in ok)/len(ok):.0f} -> {sum(r['after_gap'] for r in ok)/len(ok):.0f}")
    print(f"  reach 0.9 이상    {sum(1 for r in ok if r['before_reach']>=0.9)} -> {sum(1 for r in ok if r['after_reach']>=0.9)}")
    print(f"  곡당 평균         {sum(r['seconds'] for r in ok)/len(ok):.0f}s")
for r in bad[:5]:
    print(f"  실패: {r['artist'][:14]} - {r['title'][:18]}  {r['error'][:60]}")
PY
