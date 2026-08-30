#!/usr/bin/env python3
"""Rent one GPU box from vast.ai for alignment work and **join it to Tailscale.**

This does a different job from `Generator/scripts/rent.py`. That one brings up a Mora
**worker** — it pulls the dedicated image, registers itself with `mora.junx.dev` and
processes songs. This one only needs a **bare machine** to run review and alignment on,
and the whole point is that we ssh into it and drive it ourselves.

    rent_gpu.py offers            what is worth renting (Asia only)
    rent_gpu.py up <offer>        rent it and join it to Tailscale
    rent_gpu.py list              what we hold right now
    rent_gpu.py down <id>         destroy

The Tailscale key is given with `--authkey` or through `TS_AUTHKEY`. **Passing it as an
argument leaves it in the shell history**, so the environment variable is the better way.
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

#: Base URL of the vast.ai v0 REST API.
VAST = "https://console.vast.ai/api/v0"
#: File holding the vast.ai API key; the path can be overridden with VAST_API_KEY_FILE.
KEY = Path(os.getenv("VAST_API_KEY_FILE", Path.home() / ".config/vastai/vast_api_key"))
#: CUDA 12.8 + torch 2.7. The RTX 5090 is Blackwell (sm_120), so cu124 wheels will not run on it.
IMAGE = os.getenv("MORA_GPU_IMAGE", "pytorch/pytorch:2.7.0-cuda12.8-cudnn9-devel")
#: Rent in Asia only — YouTube blocks US datacenters; 74/74 came back 403 (MEMORY §vast.ai).
ASIA = ("Korea", "Japan", "Taiwan", "Hong Kong", "Singapore", "Thailand", "Vietnam", "Malaysia")


def vast(method: str, path: str, body: dict | None = None) -> dict:
    """Call the vast.ai REST API, backing off and retrying when it pushes back.

    vast.ai answers 429 when asked often, so each attempt that comes back 429 is retried
    after an exponential wait — six attempts, starting at 5 s and doubling up to a 60 s
    ceiling. Connection-level failures (URLError) are swallowed and retried the same way
    rather than raised: a dropped connection once killed the teardown path outright. Any
    other HTTP status is fatal and is re-raised carrying the first 300 characters of the
    response body.

    @param {str} method - HTTP method to use.
    @param {str} path - API path appended to the vast.ai base URL.
    @param {dict} [body=None] - JSON body to send; no body is sent when None.
    @returns {dict} Decoded JSON response, or an empty dict when the response body is empty.
    @throws {RuntimeError} If vast.ai answers with a non-429 HTTP error, or if all six attempts fail.
    """
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
            pass
        time.sleep(wait)
        wait = min(wait * 2, 60)
    raise RuntimeError("vast.ai 가 계속 안 받는다")


def offers(limit: int) -> None:
    """Print the cheapest rentable offers that are near enough to be useful.

    Asks vast.ai for up to 200 verified, rentable, non-external on-demand bundles with at
    least 23 GB of VRAM, 8 effective cores, 100 GB of disk, 0.97 reliability and 200 Mbit/s
    downstream, ordered cheapest first. The result is then narrowed to offers whose
    geolocation falls inside ASIA before the first `limit` of them are printed as a table.

    @param {int} limit - How many of the surviving offers to print.
    @returns {None} Nothing; the table is written to stdout.
    @throws {RuntimeError} If the vast.ai query fails.
    """
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
    """Build the boot script the rented machine runs. **Tailscale first** — nothing else lets us in.

    It uses `--tun=userspace-networking`. A rented box is a container and often has no
    `/dev/net/tun`, and without it tailscaled comes up half-way and stops. Running in
    userspace does away with that worry — all we use is ssh **into** this machine, and
    userspace networking is enough for that.

    Turning on `--ssh` makes Tailscale serve its own ssh, so there are no keys to plant and
    no port 22 to open. The script also installs curl, ffmpeg and git, and touches
    `/root/.mora-ready` at the end so the machine can be seen to have finished booting.

    @param {str} authkey - Tailscale auth key embedded in the script for `tailscale up`.
    @returns {str} A bash script for vast.ai to run when the instance starts.
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
    """Rent one offer and hand it the Tailscale boot script.

    The instance is created with the ssh runtype, which swaps out the image's entrypoint.
    That is the right choice here because we log in and drive the machine by hand rather
    than letting the image run a program of its own. Port 8787 is published on the
    instance. Joining Tailscale takes 3-5 minutes after the call returns, so the new box
    only becomes reachable some time after this function has printed its contract id.

    @param {int} offer - Offer id to rent, as printed by `offers`.
    @param {str} authkey - Tailscale auth key passed through to the boot script.
    @param {int} disk - Disk to request, in gigabytes.
    @returns {None} Nothing; the new contract id is written to stdout.
    @throws {SystemExit} If vast.ai does not report success.
    @throws {RuntimeError} If the vast.ai call itself fails.
    """
    body = {
        "client_id": "me", "image": IMAGE, "disk": disk,
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
    """Print the instances we currently hold, one line each.

    Reports the status vast.ai gives for each instance, which is how a box that is still
    booting is told apart from one that is ready to be reached over Tailscale.

    @returns {None} Nothing; a table, or a "none held" line, is written to stdout.
    @throws {RuntimeError} If the vast.ai query fails.
    """
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
    """Destroy instances by id, printing each one as it goes.

    The ids are not checked against what we actually hold, so an id vast.ai rejects
    aborts the run and leaves any remaining ids untouched.

    @param {list[int]} ids - Instance ids to destroy.
    @returns {None} Nothing; one line per destroyed instance is written to stdout.
    @throws {RuntimeError} If vast.ai refuses one of the deletes.
    """
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
