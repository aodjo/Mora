#!/usr/bin/env python3
"""
빌린 기계가 지어 둔 이미지로 곧장 워커가 되게 한다.

지금까지는 범용 pytorch 이미지를 빌리고 그 안에서 apt·pip·git·build 를 돌렸다. 하루에 네 대를
그렇게 세웠고 두 번 실패했다 — 한 번은 gcc 가 없어 diffq 가 안 서서, 한 번은 빌린 기계가 제
프로비저닝으로 apt 를 물고 있어 dpkg 락을 못 잡아서. 둘 다 이미지 안에서는 일어나지 않는 일이다.

vast.ai 는 우리가 고른 이미지를 컨테이너로 돌려 준다. 그러니 우리 이미지를 고르면 그 자체가
컨테이너 실행이고, 세울 것이 남지 않는다. 새 판이 나오면 이미지를 다시 지어 기계를 새로
빌리면 된다 — 그것이 곧 갱신이다.

사람이 PIN 을 넣어 줄 수도 없으므로 등록 토큰을 하나씩 쥐여 준다. 오래 사는 키를 모든 기계에
심지 않는 것은, 빌린 기계의 환경변수를 그 기계 주인이 읽을 수 있고 vast.ai 의 API 응답에도
그대로 나오기 때문이다. 등록 토큰은 열 분이면 만료되고 한 번 쓰면 끝나므로, 주워도 쓸 데가
없다. 워커는 그것으로 제 키를 받아 오고, 한 대가 새면 그 워커의 키만 폐기하면 된다.

    python3 Generator/scripts/rent.py offers          빌릴 만한 것 보기
    python3 Generator/scripts/rent.py up <offer> ...  그 기계들을 워커로 띄우기
    python3 Generator/scripts/rent.py list            지금 있는 것
    python3 Generator/scripts/rent.py down <id> ...   파기

up 은 관리 토큰이 필요하다 (workers.manage 권한) — MORA_ADMIN_TOKEN 으로 준다.
"""
from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

VAST = "https://console.vast.ai/api/v0"
KEY = Path(os.getenv("VAST_API_KEY_FILE", Path.home() / ".config/vastai/vast_api_key"))
IMAGE = os.getenv("MORA_GENERATOR_IMAGE", "ghcr.io/aodjo/mora-generator:latest")
ADMIN = os.getenv("MORA_ADMIN_URL", "https://mora.junx.dev")
# 유튜브가 받아 주는 곳. 미국 데이터센터에서는 74/74 가 403 이었다.
ASIA = ("Korea", "Japan", "Taiwan", "Hong Kong", "Singapore", "Thailand", "Vietnam", "Malaysia", "India")


def vast(method: str, path: str, body: dict | None = None) -> dict:
    """vast.ai 는 자주 물으면 429 를 준다. 물러섰다 다시 묻는다."""
    key = KEY.read_text().strip()
    wait = 5
    for attempt in range(6):
        request = urllib.request.Request(
            f"{VAST}{path}", data=json.dumps(body).encode() if body else None, method=method,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as error:
            if error.code != 429 or attempt == 5:
                raise SystemExit(f"vast {error.code}: {error.read().decode()[:200]}")
            time.sleep(wait)
            wait *= 2
    raise SystemExit("vast: 닿지 않는다")


def offers(limit: int) -> None:
    """빌릴 만한 것. 무엇을 보고 고르는지는 Generator/README 에 실측으로 적어 두었다."""
    query = {
        "verified": {"eq": True}, "rentable": {"eq": True}, "external": {"eq": False},
        # VRAM 이 동시판수를 정한다. 16 GB 에 두 판은 OOM 이고 24 GB 면 선다.
        "gpu_ram": {"gte": 23000}, "cpu_cores_effective": {"gte": 16},
        "disk_space": {"gte": 200}, "reliability2": {"gte": 0.97},
        "order": [["dph_total", "asc"]], "limit": 100, "type": "on-demand",
    }
    import urllib.parse
    found = vast("GET", "/bundles/?" + urllib.parse.urlencode({"q": json.dumps(query)})).get("offers", [])
    near = [o for o in found if any(a in (o.get("geolocation") or "") for a in ASIA)]
    print(f"  {'offer':>10}{'$/h':>7}{'코어':>5}{'GPU':>16}{'VRAM':>7}{'디스크':>7}  위치")
    print("  " + "─" * 74)
    for offer in near[:limit]:
        print(f"  {offer['id']:>10}{offer['dph_total']:>7.2f}{offer.get('cpu_cores_effective', 0):>5.0f}"
              f"{str(offer.get('gpu_name'))[:14]:>16}{offer.get('gpu_ram', 0) / 1000:>6.0f}G"
              f"{offer.get('disk_space', 0):>6.0f}G  {offer.get('geolocation')}")
    if not near:
        print("  아시아에 맞는 것이 없다 — 유튜브가 막는 지역은 워커로 쓸 수 없다")


def enrollment(admin_token: str) -> str:
    """한 번 쓰고 마는 등록 토큰. 기계마다 새로 받는다."""
    request = urllib.request.Request(
        f"{ADMIN.rstrip('/')}/admin/api/workers/enrollment", data=b"{}", method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {admin_token}"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode())["token"]
    except urllib.error.HTTPError as error:
        raise SystemExit(f"  등록 토큰을 못 만들었다 HTTP {error.code}: {error.read().decode()[:200]}")


def up(offer_ids: list[str], disk: int, admin_token: str) -> None:
    for offer in offer_ids:
        # 기계마다 새 토큰을 받는다. 하나가 새도 그 한 대에서 끝난다.
        token = enrollment(admin_token)
        # 기계마다 워커 번호가 달라야 한다. 같으면 Admin 이 한 워커로 본다.
        worker = f"fleet-{offer}"
        body = {
            "client_id": "me", "image": IMAGE, "disk": disk, "runtype": "ssh",
            "label": f"mora-w{offer}",
            "env": {
                "-p 22:22": "1",
                "MORA_ADMIN_URL": ADMIN,
                "MORA_ENROLL_TOKEN": token,
                "MORA_WORKER_ID": worker,
                "MORA_WORKER_NAME": worker,
            },
        }
        made = vast("PUT", f"/asks/{offer}/", body)
        print(f"  offer {offer} → contract {made.get('new_contract')} · {made.get('success')}")


def machines() -> list[dict]:
    return [r for r in vast("GET", "/instances/").get("instances", []) if str(r.get("label") or "").startswith("mora")]


def show() -> None:
    rows = machines()
    running = [r for r in rows if r.get("actual_status") == "running"]
    print(f"  {'이름':<12}{'상태':<10}{'$/h':>6}{'GPU':>16}{'VRAM':>7}  이미지")
    print("  " + "─" * 82)
    for row in sorted(rows, key=lambda r: str(r.get("label"))):
        print(f"  {str(row.get('label')):<12}{str(row.get('actual_status')):<10}{row.get('dph_total', 0):>6.2f}"
              f"{str(row.get('gpu_name'))[:14]:>16}{row.get('gpu_ram', 0) / 1000:>6.0f}G  {str(row.get('image_uuid'))[:44]}")
    print(f"\n  도는 기계 {len(running)}대 · 합계 ${sum(r.get('dph_total', 0) for r in running):.2f}/h")


def down(ids: list[str]) -> None:
    for one in ids:
        print(f"  {one}: {json.dumps(vast('DELETE', f'/instances/{one}/'))}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("what", choices=["offers", "up", "list", "down"])
    parser.add_argument("rest", nargs="*")
    parser.add_argument("--disk", type=int, default=200)
    parser.add_argument("--limit", type=int, default=12)
    parser.add_argument("--admin-token", default=os.getenv("MORA_ADMIN_TOKEN", ""))
    args = parser.parse_args()

    if args.what == "offers":
        offers(args.limit)
    elif args.what == "up":
        if not args.rest:
            raise SystemExit("  빌릴 offer 번호를 달라 — `rent.py offers` 로 고를 것")
        if not args.admin_token:
            raise SystemExit("  --admin-token 또는 MORA_ADMIN_TOKEN 이 필요하다 (workers.manage 권한)")
        up(args.rest, args.disk, args.admin_token)
    elif args.what == "list":
        show()
    elif args.what == "down":
        down(args.rest or [str(r["id"]) for r in machines()])


if __name__ == "__main__":
    main()
