#!/usr/bin/env python3
"""
잰 것을 대시보드로 보낸다.

measure.py 의 결과는 그대로 두면 터미널 스크롤백에만 남는다. 파이프라인을 고칠 때마다
"좋아졌나"를 물어야 하는데, 답이 한 사람의 화면에만 있으면 다음 사람은 물을 수가 없다.

    python3 Generator/eval/publish.py result-*.json --token <관리 토큰>

토큰은 jobs.manage 권한이 있는 것이어야 한다 — 정답셋을 돌리는 것은 워커가 아니라 사람이
손으로 시작하는 일이라 그쪽에 붙였다. MORA_ADMIN_TOKEN 으로 줘도 된다.
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

AGENT = "Mora/0.1 (+https://mora.junx.dev)"


def pipeline_version() -> str:
    """어느 판의 코드였나. 이것이 없으면 두 판을 견줄 수가 없다."""
    try:
        got = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, timeout=20)
        head = got.stdout.strip()
        dirty = subprocess.run(["git", "status", "--porcelain"], capture_output=True, text=True, timeout=20)
        # 손댄 채로 잰 것은 그렇게 적어 둔다. 커밋만 적으면 나중에 재현할 수 없다.
        return head + ("+손댐" if dirty.stdout.strip() else "") if head else "unknown"
    except Exception:
        return "unknown"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("results", nargs="+", help="measure.py 가 남긴 result-*.json")
    parser.add_argument("--admin", default=os.getenv("MORA_ADMIN_URL", "https://mora.junx.dev"))
    parser.add_argument("--token", default=os.getenv("MORA_ADMIN_TOKEN", ""))
    parser.add_argument("--truth", default="lrclib", help="정답을 어디서 가져왔나")
    parser.add_argument("--note", default="")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    songs: dict[str, dict] = {}
    for path in args.results:
        for row in json.loads(Path(path).read_text(encoding="utf-8")):
            # 같은 곡을 여러 기계가 쟀으면 나중 것을 쓴다. 곡마다 한 줄이어야 한다.
            songs[row["video_id"]] = row
    if not songs:
        sys.exit("잰 곡이 없다")

    payload = {
        "pipeline_version": pipeline_version(),
        "truth_source": args.truth,
        **({"note": args.note} if args.note else {}),
        "songs": [
            {
                "video_id": row["video_id"],
                "artist": row["artist"],
                "title": row["title"],
                "language": row.get("language", "und"),
                "lines": int(row["lines"]),
                "shift_ms": int(round(row["shift"])),
                "median_error_ms": int(round(row["median"])),
                "p90_error_ms": int(round(row["p90"])),
                "within_300_share": float(row["within300"]),
                "anchor_density": float(row["density"]),
                "breath_gaps": float(row.get("breath", 1.0)),
                # 옛 판의 결과 파일에는 없다. 없으면 없는 대로 보낸다.
                "lines_detail": row.get("lines_detail", []),
            }
            for row in songs.values()
        ],
    }
    middle = statistics.median(s["median_error_ms"] for s in payload["songs"])
    within = statistics.mean(s["within_300_share"] for s in payload["songs"])
    print(f"  곡 {len(payload['songs'])} · 오차 가운뎃값 {middle:.0f}ms · 0.3초내 {within:.0%}")
    print(f"  파이프라인 {payload['pipeline_version'][:20]}")
    if args.dry_run:
        return
    if not args.token:
        sys.exit("--token 이나 MORA_ADMIN_TOKEN 이 필요하다")

    request = urllib.request.Request(
        f"{args.admin.rstrip('/')}/admin/api/eval",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {args.token}",
                 # Cloudflare 는 urllib 의 기본 User-Agent 를 보고 1010 으로 막는다.
                 "User-Agent": AGENT},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            print(f"  올림: {json.loads(response.read().decode())}")
    except urllib.error.HTTPError as error:
        sys.exit(f"  실패 HTTP {error.code}: {error.read().decode()[:200]}")


if __name__ == "__main__":
    main()
