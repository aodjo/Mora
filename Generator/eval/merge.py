#!/usr/bin/env python3
"""흩어진 판을 하나로 모은다.

빌린 기계는 언제든 사라지므로 결과를 여러 번에 나눠 거뒀다. 같은 곡이 두 판에 있으면
나중 것을 쓴다 — 앞판은 언어 판정이 고쳐지기 전에 잰 것일 수 있다.

짜임이 둘이다. 기계가 사라진 뒤 로그에서 되살린 55 곡은 로그 줄에 찍힌 것만 있어
`err`(정수 ms)와 `within100`(백분율)뿐이고, p90·끝오차·언어가 없다. 여기서 이름을
맞춰 두되 없는 값은 만들어내지 않는다 — `full` 로 어느 쪽인지 표시한다.
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

HERE = Path(__file__).parent
CANON = Path("/tmp/jl/JamendoLyrics.csv")
HARVEST = HERE / "harvest"


def load(path: Path) -> list[dict]:
    if not path.exists():
        return []
    try:
        got = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    return got if isinstance(got, list) else [got]


def normalize(row: dict) -> dict:
    if "start_median_ms" in row:
        return {**row, "full": True}
    # 로그에서 되살린 판. `시작오차 {:.0f}ms  0.1초내 {:.0%}` 를 되읽은 것이라 이 둘만 성하다.
    return {
        "song": row["song"],
        "words": row.get("words"),
        "density": row.get("density"),
        "shift_ms": (row.get("shift") or 0) * 1000,
        "start_median_ms": float(row["err"]),
        "within_100": row["within100"] / 100,
        "full": False,
    }


def canonical_names() -> list[str]:
    if not CANON.exists():
        return []
    with CANON.open(encoding="utf-8") as handle:
        return [f"{r['Artist']} - {r['Title']}" for r in csv.DictReader(handle)]


def untruncate(rows: list[dict]) -> list[dict]:
    """되살린 판의 이름은 로그 칸 너비에 맞춰 34 자에서 잘려 있다.

    잘린 이름은 온전한 이름과 다른 열쇠가 되어, 다시 잰 여덟 곡이 겹쳐 들어와 71 곡을
    79 곡으로 부풀렸다. 정답 목록의 이름을 앞자리로 맞춰 되돌린다.
    """
    canon = canonical_names()
    if not canon:
        return rows
    out = []
    for row in rows:
        hits = [c for c in canon if c == row["song"] or c.startswith(row["song"])]
        out.append({**row, "song": hits[0]} if len(hits) == 1 else row)
    return out


def merge(parts: list[list[dict]], key: str) -> list[dict]:
    seen: dict[str, dict] = {}
    for part in parts:
        for row in part:
            if row.get(key):
                seen[row[key]] = row
    return sorted(seen.values(), key=lambda r: r[key])


# 이름을 먼저 되돌린 뒤에 합친다. 순서가 뒤바뀌면 잘린 이름이 따로 한 곡으로 남는다.
raw = untruncate([normalize(r) for part in (load(Path("/tmp/rescued-words.json")),
                                            load(HARVEST / "ssh9-words.json"),
                                            load(HARVEST / "round2-words.json"),
                                            load(HARVEST / "round4-words.json"))
                  for r in part])
# 같은 곡이 둘이면 온전한 기록을 남긴다 — 되살린 판에는 p90 도 언어도 없다.
picked: dict[str, dict] = {}
for row in raw:
    kept = picked.get(row["song"])
    if kept is None or (row["full"] and not kept["full"]):
        picked[row["song"]] = row
words = sorted(picked.values(), key=lambda r: r["song"])
lines = merge([load(HARVEST / "ssh9-lines.json"),
               load(HARVEST / "round2-lines.json"),
               load(HARVEST / "round3-lines.json")], "video_id")

(HERE / "words-all.json").write_text(json.dumps(words, ensure_ascii=False, indent=2), encoding="utf-8")
(HERE / "lines-all.json").write_text(json.dumps(lines, ensure_ascii=False, indent=2), encoding="utf-8")

full = sum(1 for r in words if r["full"])
detail = sum(1 for r in lines if r.get("lines_detail"))
print(f"낱말 {len(words)}곡 (온전한 기록 {full}곡, 로그에서 되살린 {len(words) - full}곡)")
print(f"줄  {len(lines)}곡 (줄별 기록 {detail}곡)")
