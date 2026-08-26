#!/usr/bin/env python3
"""
저장해 둔 받아쓰기로 질문들을 쓸어본다. GPU 를 쓰지 않으므로 즉시 끝난다.

  python sweep.py order      순서가 어긋난 낱말이 얼마나 되고, 그 때문에 얼마를 잃는가
  python sweep.py agree      합의 문턱(AGREE_SECONDS)을 어디에 둘 것인가
  python sweep.py leaveout   여덟 벌 중 어느 것이 보태고 어느 것이 깎는가
  python sweep.py gate       앵커 밀도·최장 빈 구간의 문턱을 어디에 둘 것인가
"""
from __future__ import annotations

import importlib.util
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

HEARING = Path("/workspace/hearing")
DAEMON = Path("/workspace/Mora/Generator/python/mora_ml_daemon.py")


def load_daemon() -> Any:
    spec = importlib.util.spec_from_file_location("daemon", DAEMON)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


daemon = load_daemon()


def songs() -> list[dict[str, Any]]:
    out = []
    for path in sorted(HEARING.glob("*.json")):
        try:
            row = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if "error" in row or not row.get("batches"):
            continue
        out.append(row)
    return out


def spread(lyric: list[str], placed: list[int]) -> int:
    """앵커 없이 이어진 가장 긴 낱말 수."""
    if not placed:
        return len(lyric)
    edges = [-1, *sorted(placed), len(lyric)]
    return max(edges[i + 1] - edges[i] - 1 for i in range(len(edges) - 1))


def vote(lyric: list[str], batches: dict[str, list[dict]], seconds: float, names: list[str] | None = None,
         merge: str = "everywhere", trust_first: bool = False) -> list[dict[str, Any]]:
    """consensus_words 와 같은 셈. 자리(index)까지 들고 나온다.

    merge:
      everywhere  지금 코드 — 섞기의 표를 모든 자리에 얹는다
      empty       설명이 말하는 것 — 표가 하나도 없는 자리만 섞기로 메운다
      never       섞기를 아예 쓰지 않는다
    trust_first:
      원본 벌이 짚은 시각을 품은 무리를 우선한다. 증강한 소리는 원본을 일그러뜨린 것이므로
      같은 한 표라도 무게가 같지 않다.
    """
    use = names if names is not None else list(batches)
    first = use[0] if use else None
    votes: dict[int, list[dict]] = defaultdict(list)
    original: dict[int, dict] = {}
    for name in use:
        for index, word in daemon.match_sequences(lyric, batches[name]).items():
            votes[index].append(word)
            if name == first:
                original[index] = word
    if merge != "never" and len(use) > 1:
        pooled = sorted((w for n in use for w in batches[n]), key=lambda w: (w["start"], w["end"]))
        for index, word in daemon.match_sequences(lyric, pooled).items():
            if merge == "empty" and index in votes:
                continue
            votes[index].append(word)
    picked = []
    for index, heard in sorted(votes.items()):
        heard.sort(key=lambda w: w["start"])
        groups = []
        for start in range(len(heard)):
            groups.append([w for w in heard[start:] if w["start"] - heard[start]["start"] <= seconds])
        best = max(groups, key=len)
        if trust_first and index in original:
            anchor = original[index]["start"]
            # 원본이 짚은 자리를 품은 무리 중 가장 큰 것. 없으면 원래대로 가장 큰 무리.
            holding = [g for g in groups if any(abs(w["start"] - anchor) < 1e-9 for w in g)]
            if holding:
                best = max(holding, key=len)
        middle = best[len(best) // 2]
        picked.append({"i": index, "text": lyric[index], "start": float(middle["start"]),
                       "end": float(middle["end"]), "votes": len(best)})
    return picked


def rematched(lyric: list[str], picked: list[dict]) -> list[int]:
    """합의 결과를 지금 파이프라인이 하는 대로 시각순으로 내보내고 다시 정렬한다."""
    by_time = sorted(picked, key=lambda w: (w["start"], w["end"]))
    return sorted(daemon.match_sequences(lyric, by_time))


def monotone(picked: list[dict]) -> list[dict]:
    """자리 순서를 거스르는 낱말을 쳐낸다 — 가장 긴 오름차순 부분열만 남긴다.

    합의는 낱말마다 자리를 알고 있으면서 시각으로만 정렬해 내보낸다. 그 뒤 전역 정렬은
    단조로운 경로만 허용하므로, 어긋난 낱말 하나가 멀쩡한 이웃을 여럿 밀어낸다. 어긋난
    쪽을 여기서 미리 버리면 정렬이 흔들릴 일이 없다.
    """
    by_time = sorted(picked, key=lambda w: (w["start"], w["end"]))
    if not by_time:
        return []
    # 자리 기준 최장 증가 부분열 (같은 자리는 한 번만 나오므로 순증가).
    import bisect
    tails: list[int] = []
    where: list[int] = []
    parent: list[int] = [-1] * len(by_time)
    for rank, word in enumerate(by_time):
        slot = bisect.bisect_left(tails, word["i"])
        if slot == len(tails):
            tails.append(word["i"]); where.append(rank)
        else:
            tails[slot] = word["i"]; where[slot] = rank
        parent[rank] = where[slot - 1] if slot > 0 else -1
    keep, cursor = [], where[-1]
    while cursor != -1:
        keep.append(cursor); cursor = parent[cursor]
    return [by_time[r] for r in reversed(keep)]


def command_order() -> None:
    rows = songs()
    print(f"{len(rows)}곡 — 합의가 자리를 준 낱말 중 시각순이 어긋난 것과, 그 대가\n")
    print(f"{'곡':<38}{'낱말':>5}{'합의':>6}{'어긋남':>7}{'재정렬후':>8}{'잃음':>6}{'단조만':>7}{'빈:재정렬':>10}{'빈:단조':>8}")
    print("─" * 100)
    worse = better = same = 0
    lost_total = saved_total = 0
    for row in sorted(rows, key=lambda r: r["artist"]):
        lyric, batches = row["lyric"], row["batches"]
        picked = vote(lyric, batches, daemon.AGREE_SECONDS)
        by_time = sorted(picked, key=lambda w: (w["start"], w["end"]))
        broken = sum(1 for a, b in zip(by_time, by_time[1:]) if a["i"] > b["i"])
        now = rematched(lyric, picked)
        kept = monotone(picked)
        fixed = sorted(w["i"] for w in kept)
        lost, saved = len(picked) - len(now), len(fixed) - len(now)
        lost_total += lost; saved_total += saved
        g_now, g_fix = spread(lyric, now), spread(lyric, fixed)
        if g_fix < g_now: better += 1
        elif g_fix > g_now: worse += 1
        else: same += 1
        name = f"{row['artist'][:15]} - {row['title'][:18]}"
        print(f"{name:<38}{len(lyric):>5}{len(picked):>6}{broken:>7}{len(now):>8}{lost:>6}{len(fixed):>7}"
              f"{g_now:>10}{g_fix:>8}")
    print("─" * 100)
    print(f"합의가 자리를 줬는데 재정렬에서 잃은 낱말 합계 {lost_total}")
    print(f"단조성만 지켜 내보내면 되찾는 낱말 합계 {saved_total}")
    print(f"최장 빈 구간: 좋아진 곡 {better} · 나빠진 곡 {worse} · 같음 {same}")


def command_agree() -> None:
    rows = songs()
    print(f"{len(rows)}곡 — 합의 문턱을 바꿔가며 (지금은 {daemon.AGREE_SECONDS}초)\n")
    print(f"{'문턱':>6}{'앵커 평균':>12}{'최장빈 평균':>14}{'빈 8 이하':>11}{'빈 20 넘음':>12}")
    print("─" * 56)
    for seconds in (0.15, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0, 1.5):
        anchors, gaps = [], []
        for row in rows:
            lyric = row["lyric"]
            picked = vote(lyric, row["batches"], seconds)
            placed = sorted(w["i"] for w in monotone(picked))
            anchors.append(len(placed) / max(1, len(lyric)))
            gaps.append(spread(lyric, placed))
        mark = "  ← 지금" if abs(seconds - daemon.AGREE_SECONDS) < 1e-9 else ""
        print(f"{seconds:>6.2f}{sum(anchors)/len(anchors):>11.1%}{sum(gaps)/len(gaps):>14.1f}"
              f"{sum(1 for g in gaps if g <= 8):>11}{sum(1 for g in gaps if g > 20):>12}{mark}")


def command_leaveout() -> None:
    """벌을 하나씩 빼며, 출하하는 경로 그대로 잰다.

    앞선 판은 monotone() 을 거쳐 쟀는데 그것은 지금 내보내는 방식이 아니다. 무엇을 뺄지
    정하는 일은 실제로 내보내는 경로에서 재야 뜻이 있다.

    평균만 보면 ±0.3 이 잡음인지 아닌지 알 수 없으므로, 곡 단위로 좋아진 수와 나빠진 수도
    함께 센다. 벌 하나가 곡당 받아쓰기 한 벌 값이므로, 값을 못 하면 빼는 것이 이득이다.
    """
    rows = songs()
    every = sorted({name for row in rows for name in row["batches"]})
    print(f"{len(rows)}곡 — 한 벌씩 빼 보며 (출하 경로 그대로)\n")
    base: list[int] = []
    base_density: list[float] = []
    for row in rows:
        placed = rematched(row["lyric"], vote(row["lyric"], row["batches"], daemon.AGREE_SECONDS))
        base.append(spread(row["lyric"], placed))
        base_density.append(len(placed) / max(1, len(row["lyric"])))
    print(f"{'벌':<12}{'앵커 평균':>11}{'최장빈 평균':>13}{'변화':>9}{'빈 20 넘음':>11}{'곡: 좋아짐':>11}{'나빠짐':>9}")
    print("─" * 78)
    print(f"{'전부':<12}{sum(base_density)/len(base_density):>10.1%}{sum(base)/len(base):>13.2f}"
          f"{'':>9}{sum(1 for g in base if g > 20):>11}")
    for drop in every:
        gaps, density = [], []
        for row in rows:
            names = [n for n in row["batches"] if n != drop]
            if not names:
                gaps.append(spread(row["lyric"], [])); density.append(0.0); continue
            placed = rematched(row["lyric"], vote(row["lyric"], row["batches"], daemon.AGREE_SECONDS, names))
            gaps.append(spread(row["lyric"], placed))
            density.append(len(placed) / max(1, len(row["lyric"])))
        change = sum(gaps)/len(gaps) - sum(base)/len(base)
        better = sum(1 for a, b in zip(gaps, base) if a < b)
        worse = sum(1 for a, b in zip(gaps, base) if a > b)
        # 뺐더니 좋아진 곡이 나빠진 곡보다 뚜렷하게 많으면 그 벌은 값을 못 한 것이다.
        verdict = "  ← 빼는 게 낫다" if better > worse + 5 else ("  기여함" if worse > better + 5 else "")
        print(f"{drop + ' 뺌':<12}{sum(density)/len(density):>10.1%}{sum(gaps)/len(gaps):>13.2f}{change:>+9.2f}"
              f"{sum(1 for g in gaps if g > 20):>11}{better:>11}{worse:>9}{verdict}")


def command_gate() -> None:
    rows = songs()
    print(f"{len(rows)}곡 — 무엇을 검수로 보낼 것인가\n")
    scored = []
    for row in rows:
        lyric = row["lyric"]
        placed = sorted(w["i"] for w in monotone(vote(lyric, row["batches"], daemon.AGREE_SECONDS)))
        scored.append({"artist": row["artist"], "title": row["title"], "language": row["language"],
                       "words": len(lyric), "density": len(placed)/max(1, len(lyric)),
                       "gap": spread(lyric, placed)})
    scored.sort(key=lambda r: r["density"])
    print(f"{'곡':<38}{'언어':<5}{'낱말':>5}{'밀도':>8}{'최장빈':>8}")
    print("─" * 68)
    for r in scored[:14]:
        print(f"{r['artist'][:15] + ' - ' + r['title'][:18]:<38}{r['language']:<5}{r['words']:>5}"
              f"{r['density']:>8.0%}{r['gap']:>8}")
    print("   …")
    for r in scored[-4:]:
        print(f"{r['artist'][:15] + ' - ' + r['title'][:18]:<38}{r['language']:<5}{r['words']:>5}"
              f"{r['density']:>8.0%}{r['gap']:>8}")
    print("\n문턱마다 걸리는 곡")
    print(f"{'밀도 문턱':>9}{'걸림':>7}   {'빈구간 문턱':>11}{'걸림':>7}")
    for density, gap in ((0.5, 30), (0.6, 25), (0.7, 20), (0.8, 15), (0.9, 10)):
        print(f"{density:>9.0%}{sum(1 for r in scored if r['density'] < density):>7}   "
              f"{gap:>11}{sum(1 for r in scored if r['gap'] > gap):>7}")
    print("\n언어별")
    by = defaultdict(list)
    for r in scored: by[r["language"]].append(r)
    for k in sorted(by):
        g = by[k]
        print(f"  {k:<5}{len(g):>3}곡  밀도 {sum(r['density'] for r in g)/len(g):>6.1%}"
              f"  최장빈 {sum(r['gap'] for r in g)/len(g):>6.1f}")


def command_recipes() -> None:
    """합의를 짓는 방식 몇 가지를 나란히 세운다.

    견주는 것은 원본만 들었을 때다. 여러 벌을 듣고도 그보다 나쁜 곡이 있다면, 더 들은 것이
    보탬이 아니라 해가 된 것이다.
    """
    rows = songs()
    print(f"{len(rows)}곡 — 합의를 짓는 방식별\n")
    ways = [
        ("원본만", dict(names=["원본"], merge="never")),
        ("지금 코드", dict(merge="everywhere")),
        ("섞기는 빈 자리만", dict(merge="empty")),
        ("섞기 안 씀", dict(merge="never")),
        ("빈 자리만 + 원본 우선", dict(merge="empty", trust_first=True)),
        ("빈 자리만 + 단조", dict(merge="empty")),
    ]
    print(f"{'방식':<24}{'앵커 평균':>11}{'최장빈 평균':>13}{'빈 8 이하':>10}{'빈 20 넘음':>11}{'원본보다 나쁜 곡':>16}")
    print("─" * 88)
    base_gaps: list[int] = []
    for label, opts in ways:
        gaps, density = [], []
        monotone_too = label.endswith("단조")
        for row in rows:
            lyric = row["lyric"]
            names = opts.get("names")
            if names and any(n not in row["batches"] for n in names):
                names = [n for n in names if n in row["batches"]] or list(row["batches"])[:1]
            picked = vote(lyric, row["batches"], daemon.AGREE_SECONDS,
                          names=names, merge=opts.get("merge", "everywhere"),
                          trust_first=opts.get("trust_first", False))
            placed = (sorted(w["i"] for w in monotone(picked)) if monotone_too
                      else rematched(lyric, picked))
            gaps.append(spread(lyric, placed))
            density.append(len(placed) / max(1, len(lyric)))
        if label == "원본만":
            base_gaps = gaps[:]
        worse = sum(1 for a, b in zip(gaps, base_gaps) if a > b) if base_gaps else 0
        print(f"{label:<24}{sum(density)/len(density):>10.1%}{sum(gaps)/len(gaps):>13.1f}"
              f"{sum(1 for g in gaps if g <= 8):>10}{sum(1 for g in gaps if g > 20):>11}{worse:>16}")


def command_korean() -> None:
    """한국어가 왜 뒤처지는가 — 못 잡은 낱말이 한글인지 영어인지 본다.

    K-pop 가사는 영어를 많이 섞는다. 한국어 모델이 영어 구절을 못 알아듣는 것이라면, 못 잡힌
    낱말은 라틴 문자에 몰려 있을 것이다. 그렇지 않고 한글에도 고루 퍼져 있다면 이야기가
    다르다 — 모델이 아니라 낱말을 가르는 방식이 문제다.
    """
    import re
    rows = songs()
    print(f"{len(rows)}곡\n")
    print(f"{'언어':<5}{'곡':>4}{'가사 라틴':>10}{'못잡음:라틴':>12}{'못잡음:한글/가나':>16}"
          f"{'영어벌 기여':>12}{'ASR/가사 낱말비':>15}")
    print("─" * 78)
    tally: dict[str, list] = defaultdict(list)
    for row in rows:
        lyric, batches = row["lyric"], row["batches"]
        picked = vote(lyric, batches, daemon.AGREE_SECONDS, merge="empty")
        placed = {w["i"] for w in monotone(picked)}
        latin = [k for k, w in enumerate(lyric) if re.search(r"[a-z]", w)]
        other = [k for k, w in enumerate(lyric) if not re.search(r"[a-z]", w)]
        missed_latin = sum(1 for k in latin if k not in placed) / max(1, len(latin))
        missed_other = sum(1 for k in other if k not in placed) / max(1, len(other))
        # 영어 벌을 빼면 얼마나 잃는가.
        without = [n for n in batches if n != "영어"]
        alone = {w["i"] for w in monotone(vote(lyric, batches, daemon.AGREE_SECONDS, without, merge="empty"))} if len(without) < len(batches) else placed
        tally[row["language"]].append((
            len(latin) / max(1, len(lyric)), missed_latin, missed_other,
            (len(placed) - len(alone)) / max(1, len(lyric)),
            len(batches["원본"]) / max(1, len(lyric)),
        ))
    for key in sorted(tally):
        group = tally[key]
        cols = [sum(x[i] for x in group) / len(group) for i in range(5)]
        print(f"{key:<5}{len(group):>4}{cols[0]:>10.0%}{cols[1]:>12.0%}{cols[2]:>16.0%}{cols[3]:>+12.1%}{cols[4]:>15.2f}")


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "order"
    {"order": command_order, "agree": command_agree, "recipes": command_recipes,
     "leaveout": command_leaveout, "gate": command_gate, "korean": command_korean}[which]()
