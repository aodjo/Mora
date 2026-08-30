#!/usr/bin/env python3
"""정렬 작업용 GPU 한 대를 vast.ai 에서 빌리고 **Tailscale 에 붙인다.**

`Generator/scripts/rent.py` 와는 다른 일을 한다. 그쪽은 Mora **워커**를 띄운다 —
전용 이미지를 받아 `mora.junx.dev` 에 등록하고 곡을 처리한다. 이쪽은 검수·정렬을 돌릴
**맨 기계**가 필요할 뿐이고, 우리가 ssh 로 들어가 쓰는 것이 목적이다.

    rent_gpu.py offers            빌릴 만한 것 (아시아만)
    rent_gpu.py up <offer>        빌리고 Tailscale 에 붙이기
    rent_gpu.py list              지금 있는 것
    rent_gpu.py down <id>         파기

Tailscale 키는 `--authkey` 로 주거나 `TS_AUTHKEY` 로 준다. **인자로 주면 명령 기록에 남으므로**
환경변수 쪽이 낫다.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

VAST = "https://console.vast.ai/api/v0"
KEY = Path(os.getenv("VAST_API_KEY_FILE", Path.home() / ".config/vastai/vast_api_key"))
# CUDA 12.8 + torch 2.7. RTX 5090 은 Blackwell(sm_120)이라 cu124 휠로는 안 돈다.
IMAGE = os.getenv("MORA_GPU_IMAGE", "pytorch/pytorch:2.7.0-cuda12.8-cudnn9-devel")
# 유튜브가 미국 데이터센터를 막는다 — 74/74 가 403 이었다(MEMORY §vast.ai).
ASIA = ("Korea", "Japan", "Taiwan", "Hong Kong", "Singapore", "Thailand", "Vietnam", "Malaysia")


def vast(method: str, path: str, body: dict | None = None) -> dict:
    """vast.ai 는 자주 물으면 429 를 준다. 물러섰다 다시 묻는다."""
    key = KEY.read_text().strip()
    wait = 5
    for _ in range(6):
        request = urllib.request.Request(
            VAST + path, method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=90) as got:
                return json.loads(got.read().decode() or "{}")
        except urllib.error.HTTPError as error:
            if error.code != 429:
                raise RuntimeError(f"vast {error.code}: {error.read().decode()[:300]}") from None
        except urllib.error.URLError:
            pass          # 연결이 끊겨도 물러섰다 다시 — 한 번 끊겨 거두는 쪽이 죽은 적이 있다
        time.sleep(wait)
        wait = min(wait * 2, 60)
    raise RuntimeError("vast.ai 가 계속 안 받는다")


def offers(limit: int) -> None:
    query = {
        "verified": {"eq": True}, "rentable": {"eq": True}, "external": {"eq": False},
        "gpu_ram": {"gte": 23000}, "cpu_cores_effective": {"gte": 8},
        "disk_space": {"gte": 100}, "reliability2": {"gte": 0.97}, "inet_down": {"gte": 200},
        "order": [["dph_total", "asc"]], "limit": 200, "type": "on-demand",
    }
    found = vast("GET", "/bundles/?" + urllib.parse.urlencode({"q": json.dumps(query)})).get("offers", [])
    near = [one for one in found if any(a in (one.get("geolocation") or "") for a in ASIA)]
    print(f"  {'offer':>10}{'$/h':>8}{'GPU':>16}{'VRAM':>7}{'코어':>5}{'디스크':>8}  위치")
    for one in near[:limit]:
        print(f"  {one['id']:>10}{one['dph_total']:>8.3f}{str(one.get('gpu_name'))[:14]:>16}"
              f"{one.get('gpu_ram', 0) / 1000:>6.0f}G{one.get('cpu_cores_effective', 0):>5.0f}"
              f"{one.get('disk_space', 0):>7.0f}G  {one.get('geolocation')}")


def onstart(authkey: str) -> str:
    """기계가 뜨자마자 할 일. **Tailscale 부터** 붙어야 우리가 들어갈 수 있다.

    `--tun=userspace-networking` 을 쓴다. 빌린 기계는 컨테이너라 `/dev/net/tun` 이 없는 일이
    흔하고, 없으면 tailscaled 가 뜨다 만다. 사용자 공간으로 돌리면 그 걱정이 없다 —
    우리가 쓰는 것은 이 기계로 **들어오는** ssh 뿐이라 그것으로 충분하다.

    `--ssh` 를 켜면 Tailscale 이 제 ssh 를 연다. 열쇠를 심을 것도, 22 번을 열 것도 없다.
    """
    return f"""#!/bin/bash
set -x
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq curl ffmpeg git >/dev/null 2>&1
curl -fsSL https://tailscale.com/install.sh | sh
mkdir -p /var/run/tailscale
tailscaled --tun=userspace-networking --state=/var/lib/tailscale/tailscaled.state \
  --socket=/var/run/tailscale/tailscaled.sock >/var/log/tailscaled.log 2>&1 &
sleep 5
tailscale --socket=/var/run/tailscale/tailscaled.sock up \
  --authkey='{authkey}' --hostname=mora-gpu --ssh --accept-routes >/var/log/ts-up.log 2>&1
tailscale --socket=/var/run/tailscale/tailscaled.sock status >/var/log/ts-status.log 2>&1
touch /root/.mora-ready
"""


def up(offer: int, authkey: str, disk: int) -> None:
    body = {
        "client_id": "me", "image": IMAGE, "disk": disk,
        # ssh 모드는 이미지의 entrypoint 를 갈아 끼운다. 우리는 들어가서 쓸 것이므로 그게 맞다.
        "runtype": "ssh ssh_direc ssh_proxy",
        "onstart": onstart(authkey),
        "env": {"-p 8787:8787": "1"},
    }
    got = vast("PUT", f"/asks/{offer}/", body)
    if not got.get("success"):
        raise SystemExit(f"못 빌렸다: {got}")
    print(f"  빌렸다 · 인스턴스 {got.get('new_contract')}")
    print("  Tailscale 에 붙는 데 3~5 분 걸린다. `rent_gpu.py list` 로 본다.")


def show() -> None:
    rows = vast("GET", "/instances/").get("instances", [])
    if not rows:
        print("  없다")
        return
    print(f"  {'id':>10} {'상태':<12} {'GPU':<14} {'$/h':>7}  {'곳'}")
    for one in rows:
        print(f"  {one['id']:>10} {str(one.get('actual_status'))[:12]:<12} "
              f"{str(one.get('gpu_name'))[:14]:<14} {one.get('dph_total', 0):>7.3f}  "
              f"{one.get('geolocation')}")


def down(ids: list[int]) -> None:
    for one in ids:
        vast("DELETE", f"/instances/{one}/", {})
        print(f"  {one} 팠음")


parser = argparse.ArgumentParser()
parser.add_argument("what", choices=["offers", "up", "list", "down"])
parser.add_argument("ids", nargs="*", type=int)
parser.add_argument("--limit", type=int, default=12)
parser.add_argument("--disk", type=int, default=120)
parser.add_argument("--authkey", default=os.getenv("TS_AUTHKEY", ""))
args = parser.parse_args()

if args.what == "offers":
    offers(args.limit)
elif args.what == "up":
    if not args.ids:
        raise SystemExit("어느 매물인지 줘야 한다")
    if not args.authkey:
        raise SystemExit("Tailscale 키가 없다 — TS_AUTHKEY 로 주거나 --authkey")
    up(args.ids[0], args.authkey, args.disk)
elif args.what == "list":
    show()
else:
    down(args.ids or [])
