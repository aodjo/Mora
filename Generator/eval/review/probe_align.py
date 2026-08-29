#!/usr/bin/env python3
"""강제 정렬이 실제로 되는지, 얼마나 걸리는지 한 곡으로 재 본다."""
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import align  # noqa: E402

HERE = Path(__file__).parent
NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")


def tokenize(text: str) -> list[str]:
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


song_id = int(sys.argv[1]) if len(sys.argv) > 1 else 1
conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
row = conn.execute("SELECT * FROM songs WHERE id=?", (song_id,)).fetchone()
if row is None:
    raise SystemExit(f"{song_id}번 곡이 없다")

found = sorted(p for p in (HERE / "audio").glob(f"{row['video_id']}.*") if p.suffix != ".part")
if not found:
    raise SystemExit(f"음원이 없다: {row['video_id']}")

lines = json.loads(row["lines"])
print(f"{row['artist']} — {row['title']} · 줄 {len(lines)} · {found[0].name}"
      + ("" if "--mixed" not in sys.argv else "  (반주 섞인 채)"))

began = time.time()
align.load()
print(f"  모델 올리기 {time.time() - began:.1f}초")

began = time.time()
separate = "--mixed" not in sys.argv
if separate:
    began2 = time.time()
    align.vocals_of(found[0])
    print(f"  보컬 뽑기 {time.time() - began2:.1f}초")
got = align.align_song(found[0], lines, tokenize, separate=separate)
spent = time.time() - began
done = sum(1 for one in got if one)
words = sum(len(one) for one in got)
print(f"  맞춤 {spent:.1f}초 · 줄 {done}/{len(lines)} · 낱말 {words}")
# 낱말 길이가 그럴듯한지. 0.06 초짜리가 줄줄이면 프레임 묶기가 또 깨진 것이다.
spans = sorted((w["end"] - w["at"]) / 1000 for one in got for w in one)
if spans:
    mid = spans[len(spans) // 2]
    print(f"  낱말 길이 최소 {spans[0]:.2f}s · 가운뎃값 {mid:.2f}s · 최대 {spans[-1]:.2f}s")
    print(f"  0.1초 미만 {sum(1 for one in spans if one < 0.1)}개 · 2초 초과 {sum(1 for one in spans if one > 2)}개")
    # 낱말 사이의 틈. 음수면 겹친 것이고, 너무 크면 어느 한쪽이 제 길이를 못 가진 것이다.
    gaps = []
    for one in got:
        for a, b in zip(one, one[1:]):
            gaps.append((b["at"] - a["end"]) / 1000)
    if gaps:
        gaps.sort()
        print(f"  낱말 사이 틈 가운뎃값 {gaps[len(gaps) // 2]:.2f}s · 음수(겹침) {sum(1 for g in gaps if g < 0)}개")

grains = [g for one in got for w in one for g in (w.get("chars") or [])]
if grains:
    lens = sorted((g["end"] - g["at"]) / 1000 for g in grains)
    print(f"  글자 {len(grains)}개 · 길이 가운뎃값 {lens[len(lens) // 2]:.2f}s "
          f"· 0.05초 미만 {sum(1 for one in lens if one < 0.05)}개 · 최대 {lens[-1]:.2f}s")
    # 글자끼리 이어졌는가. 어절 안에서는 틈이 0 이어야 한다.
    holes = []
    for one in got:
        for w in one:
            cs = w.get("chars") or []
            holes += [(b["at"] - a["end"]) / 1000 for a, b in zip(cs, cs[1:])]
    if holes:
        print(f"  어절 안 글자 사이 틈: 0 이 아닌 것 {sum(1 for h in holes if abs(h) > 0.001)}개 / {len(holes)}")

# 어절이 제 글자를 감싸는가. 어긋나면 화면에서 글자가 막대 밖으로 나간다.
bad = [w for one in got for w in one
       if w.get("chars") and (w["at"] > w["chars"][0]["at"] or w["end"] < w["chars"][-1]["end"])]
print(f"  글자가 어절 밖으로 나간 것 {len(bad)}개" + ("" if not bad else f"  보기: {bad[0]['text']}"))

# 글자가 한 자리에 몰린 곳. 0.04 초 안에 붙은 것은 사람이 낼 수 없는 간격이다.
starts = [g["at"] for one in got for w in one for g in (w.get("chars") or [{"at": w["at"]}])]
tight = sum(1 for a, b in zip(starts, starts[1:]) if 0 <= b - a <= 40)
print(f"  0.04초 안에 붙은 글자 {tight}개 / {len(starts)}")

sures = sorted(g.get("sure", 0) for one in got for w in one for g in (w.get("chars") or []))
if sures:
    shaky = sum(1 for one in got for w in one for g in (w.get("chars") or []) if g.get("shaky"))
    print(f"  확신도 가운뎃값 {sures[len(sures) // 2]:.2f} · 가장 낮은 것 {sures[0]:.2f}")
    print(f"  미심쩍다고 짚은 글자 {shaky}개 / {len(sures)}  ({shaky / len(sures):.0%})")

# 진짜 잣대: 바이브·LRCLIB 이 준 **줄 시작 시각**과 견준다.
#
# 확신도는 「모델의 1순위가 그 글자와 같은가」를 재는데, 1순위가 달라도 시각은 맞을 수 있다.
# 우리가 알고 싶은 것은 시각이므로, 밖에서 온 줄 시각과 대는 것이 옳다.
gaps = []
for index, one in enumerate(got):
    if not one:
        continue
    ours = one[0]["at"]
    theirs = lines[index].get("at")
    if theirs is not None:
        gaps.append(ours - theirs)
if gaps:
    ranked = sorted(gaps)
    mid = ranked[len(ranked) // 2]
    off = sorted(abs(one - mid) for one in gaps)
    print(f"\n  줄 시작을 바이브와 견줌 ({len(gaps)}줄)")
    print(f"    치우침(가운뎃값) {mid / 1000:+.2f}s — 음원이 다르면 곡 전체가 이만큼 밀린다")
    print(f"    치우침 뺀 오차: 가운뎃값 {off[len(off) // 2]:.0f}ms · p90 {off[int(len(off) * 0.9)]:.0f}ms")
    print(f"    0.3초 넘게 어긋난 줄 {sum(1 for one in off if one > 300)}개")

print("\n  앞 세 줄")
for index, one in enumerate(got[:3]):
    print(f"   [{index}] 줄 {lines[index]['at'] / 1000:.2f}s  {lines[index]['text'][:34]}")
    for word in one[:6]:
        print(f"        {word['at'] / 1000:7.2f} ~ {word['end'] / 1000:6.2f}  {word['text']}")
        for grain in (word.get("chars") or [])[:8]:
            flag = "  ← 미심쩍음" if grain.get("shaky") else ""
            print(f"            {grain['at'] / 1000:7.2f} ~ {grain['end'] / 1000:6.2f}  "
                  f"{grain['text']}  ({grain.get('sure', 0):.2f}){flag}")
