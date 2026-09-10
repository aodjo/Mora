#!/usr/bin/env python3
"""**쌩 가사에서 빠지는 줄은 왜 빠지나.** `probe_blind` 가 `MORA_BLIND_DUMP` 로 남긴 줄별 기록을 읽어,
제자리(곡 어긋남 가운뎃값에서 0.5 초 안)를 벗어난 줄을 셋으로 가른다:

  * **잔해** — 줄이 통째로 펴졌거나 뭉쳤거나 막힌 프레임을 뚫었다(소리를 못 찾은 줄).
  * **구간** — 이웃 줄도 같은 쪽으로 같이 어긋났다(시계가 그 구간에서 틀렸다).
  * **홀로** — 이웃은 맞는데 그 줄만 어긋났다(경계·꼬리 문제).

@example
  python probe_miss.py blind.jsonl
"""
import json
import sys


def kind_of(line: dict) -> str:
    """Grade a line the way the retry loop does, from the dumped fields.

    @param {dict} line - One dumped line.
    @returns {str} "막힘", "균일", "뭉침", or "멀쩡".
    """
    if line["sure"] is not None and line["sure"] <= -1000:
        return "막힘"
    if line["gap_min"] is not None and line["n"] >= 3 and line["gap_max"] - line["gap_min"] <= 3:
        return "균일"
    if line["flat"] or (line["gap_min"] is not None and line["gap_min"] <= 0):
        return "뭉침"
    return "멀쩡"


def main() -> int:
    """Print per song the misses and their kinds, then the totals.

    @returns {int} 0 always.
    """
    total = {"잔해": 0, "구간": 0, "홀로": 0, "줄": 0, "빠짐": 0}
    for raw in open(sys.argv[1], encoding="utf-8"):
        song = json.loads(raw)
        rows = [one for one in song["lines"] if one["sheet"] is not None and one["ours"] is not None]
        offs = {one["index"]: (one["ours"] - one["sheet"]) / 1000 - song["mid"] for one in rows}
        miss = [one for one in rows if abs(offs[one["index"]]) > 0.5]
        kinds = {"잔해": [], "구간": [], "홀로": []}
        for one in miss:
            index = one["index"]
            grade = kind_of(one)
            if grade != "멀쩡":
                kinds["잔해"].append((index, offs[index], grade))
                continue
            near = [offs[k] for k in (index - 1, index + 1) if k in offs and abs(offs[k]) > 0.5
                    and (offs[k] > 0) == (offs[index] > 0)]
            (kinds["구간"] if near else kinds["홀로"]).append((index, offs[index], grade))
        total["줄"] += len(rows)
        total["빠짐"] += len(miss)
        for key in ("잔해", "구간", "홀로"):
            total[key] += len(kinds[key])
        print(f"  [{song['id']:>2}] {song['title'][:14]:<14} 줄 {len(rows):>3} · 빠짐 {len(miss):>3}  "
              f"잔해 {len(kinds['잔해']):>2} · 구간 {len(kinds['구간']):>2} · 홀로 {len(kinds['홀로']):>2}")
        for key in ("잔해", "구간", "홀로"):
            if kinds[key]:
                print(f"        {key}: " + " ".join(f"{index}({off:+.1f}{'·' + grade if grade != '멀쩡' else ''})"
                                                   for index, off, grade in kinds[key]))
    print(f"\n  통틀어 줄 {total['줄']} · 빠짐 {total['빠짐']} = 잔해 {total['잔해']} + 구간 {total['구간']} + 홀로 {total['홀로']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
