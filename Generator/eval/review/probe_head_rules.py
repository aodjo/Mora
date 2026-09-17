"""keep·move 로 남긴 줄 머리를 섞어, 줄마다 어느 쪽을 고르는 규칙이 가장 많이 맞추는지 곡을 다시 돌리지 않고 잰다.

셈은 probe_par 와 같다 — 곡마다 가운데값을 빼고 0.5 초·0.25 초 안에 든 줄을 센다.

    python probe_head_rules.py ~/mora-bench/dumps ~/mora-val2/dumps
    MORA_WATCH="아름다운 세상" python probe_head_rules.py ...   # 한 곡의 0.5초·0.25초도 따로 본다
"""
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from probe_onset import nearest, onsets_of  # noqa: E402

EDGE_MS = 300


def load(root: Path) -> list[dict]:
    """Pair every song's keep and move dumps and attach each line's features.

    @param {Path} root - A directory holding `keep/` and `move/`.
    @returns {list[dict]} One entry per song: id, title, and per-line `rows` with sheet time, both heads and features.
    """
    songs = []
    for kept in sorted((root / "keep").glob("*.json"), key=lambda p: int(p.stem)):
        moved = root / "move" / kept.name
        if not moved.exists():
            continue
        k, m = json.load(open(kept, encoding="utf-8")), json.load(open(moved, encoding="utf-8"))
        marks = onsets_of(Path(k["lead"]))
        rows = []
        for index, sheet in enumerate(k["sheet"]):
            a, b = k["heads"][index], m["heads"][index]
            if sheet is None or (a is None and b is None):
                continue
            a = a or b
            b = b or a
            rows.append({"index": index, "sheet": sheet, "k": a["at"], "m": b["at"], "d": b["at"] - a["at"],
                         "gk": nearest(marks, a["at"]), "gm": nearest(marks, b["at"]), "grains": a["grains"],
                         "first": a["end"] - a["at"], "span": a["last"] - a["at"], "lane": k["lanes"].get(str(index), 0)})
        songs.append({"id": k["id"], "title": k["title"], "rows": rows})
    return songs


def score(song: dict, pick) -> tuple[int, int, int]:
    """Score one song when each line's head comes from `pick`.

    @param {dict} song - One entry from `load`.
    @param {callable} pick - Row → True to take the refiner's (move) head.
    @returns {tuple[int, int, int]} Lines within 0.5 s, within 0.25 s, and lines counted.
    """
    off = sorted(((r["m"] if pick(r) else r["k"]) - r["sheet"]) / 1000 for r in song["rows"])
    if not off:
        return 0, 0, 0
    mid = off[len(off) // 2]
    return sum(1 for o in off if abs(o - mid) <= 0.5), sum(1 for o in off if abs(o - mid) <= 0.25), len(off)


def oracle(song: dict) -> tuple[int, int, int]:
    """Best case: every line takes whichever head sits nearer the sheet, measured from the keep median.

    @param {dict} song - One entry from `load`.
    @returns {tuple[int, int, int]} Same as `score`.
    """
    off = sorted((r["k"] - r["sheet"]) / 1000 for r in song["rows"])
    mid = off[len(off) // 2] * 1000 if off else 0
    return score(song, lambda r: abs(r["m"] - r["sheet"] - mid) < abs(r["k"] - r["sheet"] - mid))


RULES = {
    "keep": lambda r: False,
    "move": lambda r: True,
    **{f"onset+{m}": (lambda m: lambda r: r["gm"] + m < r["gk"])(m) for m in (0, 30, 60, 100)},
    **{f"earlier>{x}": (lambda x: lambda r: r["d"] < -x)(x) for x in (100, 200, 250)},
    **{f"later>{x}": (lambda x: lambda r: r["d"] > x)(x) for x in (50, 100, 200)},
    **{f"grains<={n}": (lambda n: lambda r: r["grains"] <= n)(n) for n in (3, 4, 5, 6)},
    **{f"grains<={n}&onset+30": (lambda n: lambda r: r["grains"] <= n and r["gm"] + 30 < r["gk"])(n) for n in (4, 5, 6)},
    "not-edge": lambda r: r["d"] > -(EDGE_MS - 40),
    "not-edge&onset+30": lambda r: r["d"] > -(EDGE_MS - 40) and r["gm"] + 30 < r["gk"],
    "first>600": lambda r: r["first"] > 600,
    "first>400&onset+30": lambda r: r["first"] > 400 and r["gm"] + 30 < r["gk"],
}


def main() -> int:
    """Print every rule's totals per group, then who wins the lines where the two heads disagree.

    @returns {int} 0 always.
    """
    groups = {Path(one).parent.name: load(Path(one)) for one in sys.argv[1:]}
    names = list(groups)
    print(f"{'규칙':<22}" + "".join(f"{n:>18}" for n in names) + f"{'합':>14}{'지켜볼 곡':>10}")
    table = {**RULES, "oracle": None}
    for name, pick in table.items():
        cells, total = [], [0, 0]
        watch = ""
        for group in names:
            h = t = n = 0
            for song in groups[group]:
                a, b, c = oracle(song) if pick is None else score(song, pick)
                h, t, n = h + a, t + b, n + c
                if os.environ.get("MORA_WATCH") and os.environ["MORA_WATCH"] in song["title"]:
                    watch = f"{a}/{b}"
            cells.append(f"{h:>5} {t:>4} /{n:<4}")
            total[0] += h
            total[1] += t
        print(f"{name:<22}" + "".join(f"{c:>18}" for c in cells) + f"{total[0]:>7} {total[1]:>5}{watch:>10}")

    print("\n갈린 줄(|d|>=100ms) — keep 가운데값 기준으로 어느 머리가 정답에 가까운가")
    buckets: dict[str, list[int]] = {}
    for group in names:
        for song in groups[group]:
            off = sorted(r["k"] - r["sheet"] for r in song["rows"])
            mid = off[len(off) // 2] if off else 0
            for r in song["rows"]:
                if abs(r["d"]) < 100:
                    continue
                ek, em = abs(r["k"] - r["sheet"] - mid), abs(r["m"] - r["sheet"] - mid)
                keys = [f"d {'앞' if r['d'] < 0 else '뒤'} {min(abs(r['d']) // 100 * 100, 400)}+",
                        f"onset {'m가까움' if r['gm'] + 30 < r['gk'] else ('k가까움' if r['gk'] + 30 < r['gm'] else '비슷')}",
                        f"음절 {'<=4' if r['grains'] <= 4 else ('5-8' if r['grains'] <= 8 else '9+')}",
                        f"그룹 {group}"]
                for key in keys:
                    got = buckets.setdefault(key, [0, 0, 0])
                    got[0 if em + 50 < ek else (1 if ek + 50 < em else 2)] += 1
    print(f"  {'':<18}{'move 나음':>10}{'keep 나음':>10}{'비슷':>6}")
    for key in sorted(buckets):
        print(f"  {key:<18}" + "".join(f"{v:>10}" for v in buckets[key][:2]) + f"{buckets[key][2]:>6}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
