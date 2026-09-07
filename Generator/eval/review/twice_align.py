"""한 프로세스에서 같은 곡을 두 번 맞추면 두 번째 시계가 무너지나. 화자 자르기 사전이 덧쓰이는지 본다."""
import json, sqlite3, sys, os
sys.path.insert(0, ".")
import align
from probe_alien import words_of
v = "9IdrqklRKzI"
found = align.source_in(align.Path("audio"), v)
c = sqlite3.connect(os.environ.get("MORA_DB", "review.db"))
lines = json.loads(c.execute("SELECT lines FROM songs WHERE id=12").fetchone()[0])
for turn in (1, 2):
    blind = [{**L, "at": None} for L in lines]
    said = align.voices_apart(found)
    print(f"  {turn}판 전  사전 열쇠 {sorted(said.keys())} · 쪽 {len(said.get('쪽', []))}명 · 토막 수 {[len(w['토막']) for w in said.get('쪽', [])]}", flush=True)
    g = align.guess_clock(found, blind, words_of)
    print(f"  {turn}판 고른 짐작 앞 8: {[round(x/1000,1) for x in g[:8]]}", flush=True)
    out, lanes = align.align_voices(found, blind, words_of, "야해")
    said = align.voices_apart(found)
    print(f"  {turn}판 후  사전 열쇠 {sorted(said.keys())} · 토막 수 {[len(w['토막']) for w in said.get('쪽', [])]}", flush=True)
    ch = [x for w in out[5] for x in (w.get("chars") or []) if x.get("at") is not None]
    print(f"  {turn}판 5번 줄 {ch[0]['at']/1000:.2f}s" if ch else f"  {turn}판 5번 없음", flush=True)
