#!/usr/bin/env python3
"""**열두 곡을 다시 맞춘다.** 하나씩 시켜 놓고 끝날 때까지 지켜본다.

정렬기를 고칠 때마다 곡을 통째로 다시 돌려야 재는 자가 새 결과를 본다. 서버는 한 곡씩만
맞추므로 차례로 시키고, 그 곡이 끝나야 다음을 시작한다.

@example
  python redo.py            # 전부
  python redo.py 8 11       # 이 두 곡만
"""
import json
import sys
import time
import urllib.error
import urllib.request

#: 어디에 시키나.
BASE = "http://127.0.0.1:8787"
#: 얼마나 자주 물어보나(초).
ASK_EVERY = 1.0
#: 한 곡이 이보다 오래 걸리면 손 든다(초).
GIVE_UP = 900


def ask(where: str, post: bool = False) -> dict | list:
    """Fetch JSON from the review server.

    @param {str} where - Path under `BASE`.
    @param {bool} [post=False] - Send an empty POST instead of a GET.
    @returns {dict | list} The decoded body.
    """
    req = urllib.request.Request(f"{BASE}{where}", method="POST" if post else "GET",
                                 data=b"{}" if post else None,
                                 headers={"Content-Type": "application/json"} if post else {})
    with urllib.request.urlopen(req, timeout=120) as got:
        return json.load(got)


def main() -> int:
    """Re-align every song in turn, printing how long each took.

    @returns {int} 0 always.
    """
    want = {int(one) for one in sys.argv[1:]}
    songs = sorted(ask("/api/songs"), key=lambda one: one["id"])
    for song in songs:
        if want and song["id"] not in want:
            continue
        began = time.time()
        ask(f"/api/songs/{song['id']}/align", post=True)
        #: 서버는 끝을 따로 알리지 않고 `state` 글월이 `done` 이나 `실패` 로 바뀔 뿐이다.
        #: `done` 이라는 열쇠를 찾으면 영원히 못 찾고 `GIVE_UP` 까지 헛돈다.
        while True:
            time.sleep(ASK_EVERY)
            state = ask(f"/api/songs/{song['id']}/align").get("state", "")
            if state.startswith(("done", "실패")) or time.time() - began > GIVE_UP:
                break
        print(f"  [{song['id']:>2}] {song['title'][:22]:<24} {time.time() - began:5.0f}초  {state[:56]}",
              flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
