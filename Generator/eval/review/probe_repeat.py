#!/usr/bin/env python3
"""**되풀이되는 구절에서 정렬이 무너지는가.** 짐작을 수치로 못박는다.

강제 정렬은 소리와 글자를 차례를 지키며 맞춘다. 그런데 같은 구절이 곡에서 여러 번 나오면
그 둘이 소리로 구별되지 않는다 — 「잠깐이면 돼 잠깐이면」의 두 번째를 첫 번째 자리에 겹쳐
놓아도 점수가 거의 같다. 그래서 한쪽이 20ms 에 욱여넣어지거나 몇 초씩 밀린다.

여기서 재는 것은 하나다 — **되풀이되는 줄의 오차가 한 번뿐인 줄보다 큰가.** 크지 않으면
되풀이는 범인이 아니고 다른 데를 봐야 한다.
"""
import json
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402

NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")


def words_of(text: str) -> list[str]:
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def middle(values: list[int]) -> int:
    return sorted(values)[len(values) // 2] if values else 0


conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
rows = conn.execute("SELECT id, artist, title, video_id, lines FROM songs ORDER BY id").fetchall()
how_many = int(sys.argv[1]) if len(sys.argv) > 1 else 3

everything: list[tuple[bool, int, str, float, float]] = []
for row in rows[:how_many]:
    found = align.source_in(HERE / "audio", row["video_id"])
    if not found:
        continue
    lines = json.loads(row["lines"])
    got = align.align_song(found, lines, words_of)

    # 곡 전체의 치우침은 뺀다. 그것은 음원이 달라 생긴 것이지 정렬의 흔들림이 아니다.
    pairs = [(i, one) for i, one in enumerate(got) if one and lines[i].get("at") is not None]
    if not pairs:
        continue
    bias = middle([one[0]["at"] - lines[i]["at"] for i, one in pairs])

    # 같은 글월이 몇 번 나오나. 띄어쓰기와 대소문자만 고르고 그대로 센다.
    said = Counter(re.sub(r"\s+", " ", line.get("text", "")).strip().lower() for line in lines)

    print(f"\n  [{row['id']}] {row['artist'][:14]} — {row['title'][:24]} · 줄 {len(lines)}")
    twice, once = [], []
    for i, one in pairs:
        text = re.sub(r"\s+", " ", lines[i].get("text", "")).strip().lower()
        off = abs(one[0]["at"] - lines[i]["at"] - bias)
        # 그 줄이 얼마나 촘촘히 욱여넣어졌나. 사람이 낼 수 없는 속도면 정렬이 무너진 것이다.
        chars = [c for w in one for c in (w.get("chars") or [])]
        span = (chars[-1]["at"] - chars[0]["at"]) if len(chars) > 1 else 0
        rate = len(chars) / (span / 1000) if span > 0 else 0.0
        (twice if said[text] > 1 else once).append((off, rate))
        everything.append((said[text] > 1, off, text, rate, row["id"]))

    for name, group in (("되풀이되는 줄", twice), ("한 번뿐인 줄", once)):
        if not group:
            print(f"    {name:<10} 없음")
            continue
        offs = sorted(one for one, _ in group)
        print(f"    {name:<10} {len(group):>3}줄 · 오차 가운데 {offs[len(offs) // 2]:>5.0f}ms · "
              f"p90 {offs[int(len(offs) * 0.9)]:>6.0f}ms · 0.3초 초과 {sum(1 for one in offs if one > 300):>2}줄 · "
              f"초당 {middle([int(r) for _, r in group]):>2}자 넘는 줄 "
              f"{sum(1 for _, r in group if r > 12):>2}")

both = [one for one in everything if one[0]]
solo = [one for one in everything if not one[0]]
if both and solo:
    print(f"\n  통틀어 — 되풀이 {len(both)}줄 중 0.3초 초과 {sum(1 for one in both if one[1] > 300)}"
          f" ({sum(1 for one in both if one[1] > 300) * 100 // len(both)}%)"
          f" · 한 번뿐 {len(solo)}줄 중 {sum(1 for one in solo if one[1] > 300)}"
          f" ({sum(1 for one in solo if one[1] > 300) * 100 // len(solo)}%)")
    print("\n  가장 어긋난 여덟 줄 — 되풀이 여부와 함께")
    for is_twice, off, text, rate, sid in sorted(everything, key=lambda one: -one[1])[:8]:
        print(f"    {off:>6.0f}ms  {'되풀이' if is_twice else '한번  '}  초당 {rate:>4.1f}자  "
              f"[{sid}] {text[:36]}")
