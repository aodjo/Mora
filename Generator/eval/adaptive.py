#!/usr/bin/env python3
"""
이미 잘 맞는 곡에는 여러 벌을 듣지 않는 것이 나은가.

지금은 곡마다 여덟 벌을 모두 듣고 합의한다. 그것이 전체로는 이기지만, 이미 잘 맞던 곡에서는
최장 빈 구간을 오히려 늘린다 — 새로 온 앵커가 엉뚱한 시각에 놓여 단조성을 지키려는 정렬이
멀쩡한 이웃을 버리기 때문으로 본다.

  제안: 원본 한 벌로 잰 최장 빈 구간이 T 이하면 원본을 그대로 쓰고, 넘을 때만 나머지를 듣는다.

세 가지를 잰다.
  1) T 별 성능 — 앵커 밀도, 최장 빈 구간, 빈≤8 곡 수, 원본보다 나빠진 곡 수, 언어별
  2) 문턱이 이 표본에 과적합인가 — 곡을 반씩 갈라 한쪽에서 고르고 다른 쪽에서 잰다
  3) 하드한 곡에 여덟 벌이 다 필요한가 — 탐욕적으로 하나씩 더해 가며 잰다

sweep.py 의 vote/monotone/rematched 를 그대로 빌려 쓴다. 합의를 짓는 방식이 출하 경로와
달라지면 여기서 나온 답이 출하될 때는 다른 답이 된다.
"""
from __future__ import annotations

import importlib.util
import json
import random
import statistics
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

HEARING = Path("/workspace/hearing")
SWEEP = Path("/workspace/sweep.py")


def load(path: Path, name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


sweep = load(SWEEP, "sweep")
daemon = sweep.daemon
AGREE = daemon.AGREE_SECONDS
ALL_NAMES: list[str] = []


def songs() -> list[dict[str, Any]]:
    rows = []
    for path in sorted(HEARING.glob("*.json")):
        try:
            row = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if row.get("lyric") and row.get("batches"):
            rows.append(row)
    return rows


def placed_indices(row: dict[str, Any], names: list[str] | None) -> set[int]:
    """
    이 벌들로 합의했을 때 자리를 잡은 가사 낱말의 번호.

    곡마다 가진 벌이 다르다 — 영어 곡에는 '영어로 다시 듣기' 벌이 없다. 첫 곡의 목록을
    모든 곡에 들이대면 없는 벌을 찾다가 멈춘다.
    """
    have = row["batches"]
    wanted = None if names is None else [name for name in names if name in have]
    if wanted is not None and not wanted:
        return set()
    picked = sweep.vote(row["lyric"], have, AGREE, wanted) if wanted is not None else sweep.vote(row["lyric"], have, AGREE)
    return {int(word["i"]) for word in sweep.monotone(picked)}


def gap_of(placed: set[int], total: int) -> int:
    """앵커 없이 이어진 가장 긴 낱말 수."""
    longest = run = 0
    for index in range(total):
        run = 0 if index in placed else run + 1
        longest = max(longest, run)
    return longest


def measure(row: dict[str, Any], names: list[str] | None) -> tuple[int, int]:
    placed = placed_indices(row, names)
    return len(placed), gap_of(placed, len(row["lyric"]))


def summarise(rows: list[dict[str, Any]], choose, label: str, base: dict[str, tuple[int, int]]) -> dict[str, Any]:
    anchors = gaps = words = 0
    per_language: dict[str, list[int]] = defaultdict(list)
    per_language_words: dict[str, int] = defaultdict(int)
    per_language_anchors: dict[str, int] = defaultdict(int)
    worse = under8 = over20 = 0
    collected: list[int] = []
    for row in rows:
        a, g = choose(row)
        words += len(row["lyric"])
        anchors += a
        collected.append(g)
        language = row.get("language", "?")
        per_language[language].append(g)
        per_language_words[language] += len(row["lyric"])
        per_language_anchors[language] += a
        if g > base[row["video_id"]][1]:
            worse += 1
        if g <= 8:
            under8 += 1
        if g > 20:
            over20 += 1
    return {
        "label": label,
        "density": anchors / max(1, words),
        "gap_mean": statistics.mean(collected),
        "gap_median": statistics.median(collected),
        "under8": under8,
        "over20": over20,
        "worse": worse,
        "by_language": {
            lang: (per_language_anchors[lang] / max(1, per_language_words[lang]), statistics.mean(per_language[lang]), len(per_language[lang]))
            for lang in sorted(per_language)
        },
    }


def show(result: dict[str, Any]) -> None:
    langs = " ".join(f"{lang}:{d*100:.0f}%/{g:.1f}" for lang, (d, g, _) in result["by_language"].items())
    print(
        f"{result['label']:30}{result['density']*100:>7.1f}%{result['gap_mean']:>8.1f}{result['gap_median']:>7.0f}"
        f"{result['under8']:>7}{result['over20']:>7}{result['worse']:>7}   {langs}"
    )


def main() -> None:
    rows = songs()
    global ALL_NAMES
    ALL_NAMES = list(rows[0]["batches"].keys())
    print(f"{len(rows)}곡 · 벌 {ALL_NAMES} · 합의 문턱 {AGREE}초\n")

    # 한 곡에 두 번씩 합의를 짓는다. 144곡이면 몇 분이 걸리므로 어디까지 왔는지 말한다.
    cache = Path("/workspace/adaptive-cache.json")
    if cache.exists():
        stored = json.loads(cache.read_text())
        origin = {k: tuple(v) for k, v in stored["origin"].items()}
        everything = {k: tuple(v) for k, v in stored["everything"].items()}
        print(f"  재어 둔 값 사용 ({len(origin)}곡)\n")
    else:
        origin, everything = {}, {}
    for index, row in enumerate(rows, 1):
        if row["video_id"] in origin:
            continue
        origin[row["video_id"]] = measure(row, ["원본"])
        everything[row["video_id"]] = measure(row, None)
        print(f"\r  재는 중 {index}/{len(rows)}  {row.get('artist','')[:18]} - {row.get('title','')[:22]}".ljust(78), end="", flush=True)
    print("\r".ljust(80) + "\r", end="", flush=True)
    cache.write_text(json.dumps({"origin": {k: list(v) for k, v in origin.items()}, "everything": {k: list(v) for k, v in everything.items()}}))

    print(f"{'방식':30}{'앵커밀도':>8}{'최장빈':>8}{'중앙':>7}{'빈≤8':>7}{'빈>20':>7}{'나빠짐':>7}   언어별 밀도/최장빈")
    print("─" * 128)
    show(summarise(rows, lambda r: origin[r["video_id"]], "원본만", origin))
    show(summarise(rows, lambda r: everything[r["video_id"]], "합의(여덟 벌·지금)", origin))
    for threshold in (2, 4, 6, 8, 10, 12, 16, 24):
        def pick(row, t=threshold):
            return origin[row["video_id"]] if origin[row["video_id"]][1] <= t else everything[row["video_id"]]

        spared = sum(1 for row in rows if origin[row["video_id"]][1] <= threshold)
        result = summarise(rows, pick, f"빈≤{threshold} 원본, 아니면 합의", origin)
        result["label"] = f"{result['label']}  (덜 듣는 곡 {spared})"
        show(result)
    show(
        summarise(
            rows,
            lambda r: max([origin[r["video_id"]], everything[r["video_id"]]], key=lambda p: (-p[1], p[0])),
            "신탁(둘 중 좋은 쪽·상한)",
            origin,
        )
    )

    # ── 문턱이 이 표본에 과적합인가 ──────────────────────────────────────────
    print("\n반씩 갈라 한쪽에서 고르고 다른 쪽에서 재기 (40회)")
    candidates = list(range(0, 25))

    def score_on(subset: list[dict[str, Any]], threshold: int) -> tuple[int, int]:
        under8 = worse = 0
        for row in subset:
            a, g = origin[row["video_id"]] if origin[row["video_id"]][1] <= threshold else everything[row["video_id"]]
            if g <= 8:
                under8 += 1
            if g > origin[row["video_id"]][1]:
                worse += 1
        return under8, worse

    chosen: list[int] = []
    held_fitted: list[float] = []
    held_fixed: list[float] = []
    for seed in range(40):
        shuffled = rows[:]
        random.Random(seed).shuffle(shuffled)
        half = len(shuffled) // 2
        train, test = shuffled[:half], shuffled[half:]
        best = max(candidates, key=lambda t: (score_on(train, t)[0] - score_on(train, t)[1], -t))
        chosen.append(best)
        held_fitted.append(score_on(test, best)[0] - score_on(test, best)[1])
        held_fixed.append(score_on(test, 8)[0] - score_on(test, 8)[1])
    print(f"  고른 문턱 분포: {sorted(set(chosen))} · 중앙 {statistics.median(chosen):.0f} · 최빈 {max(set(chosen), key=chosen.count)}")
    print(f"  남긴 쪽 점수(빈≤8 − 나빠짐): 고른 문턱 {statistics.mean(held_fitted):.2f} · 고정 8 {statistics.mean(held_fixed):.2f}")

    print("\n  언어별 최적 문턱")
    for language in sorted({row.get("language", "?") for row in rows}):
        subset = [row for row in rows if row.get("language") == language]
        if len(subset) < 5:
            continue
        best = max(candidates, key=lambda t: (score_on(subset, t)[0] - score_on(subset, t)[1], -t))
        print(f"    {language} ({len(subset)}곡): {best}")

    # ── 하드한 곡에 여덟 벌이 다 필요한가 ────────────────────────────────────
    hard = [row for row in rows if origin[row["video_id"]][1] > 8]
    print(f"\n합의가 필요한 곡 {len(hard)}개 — 벌을 하나씩 더해 가며")
    full = {row["video_id"]: everything[row["video_id"]] for row in hard}
    target = statistics.mean(full[row["video_id"]][1] for row in hard)
    picked: list[str] = ["원본"]
    while len(picked) < len(ALL_NAMES):
        best_name, best_gap = None, None
        for name in ALL_NAMES:
            if name in picked:
                continue
            trial = picked + [name]
            mean_gap = statistics.mean(measure(row, trial)[1] for row in hard)
            if best_gap is None or mean_gap < best_gap:
                best_name, best_gap = name, mean_gap
        assert best_name is not None
        picked.append(best_name)
        density = sum(measure(row, picked)[0] for row in hard) / sum(len(row["lyric"]) for row in hard)
        print(f"  {len(picked)}벌 {picked!s:64} 최장빈 {best_gap:5.1f}  (여덟 벌 {target:.1f})  밀도 {density*100:.1f}%")


if __name__ == "__main__":
    main()
