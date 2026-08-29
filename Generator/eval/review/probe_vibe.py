#!/usr/bin/env python3
"""바이브 검색이 왜 비는지 단계마다 세어 본다. 삼킨 예외를 여기서는 드러낸다."""
import json
import sys
import urllib.parse
import urllib.request

VIBE = "https://apis.naver.com/vibeWeb/musicapiweb"
BROWSER = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
           "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def get(path: str) -> dict:
    request = urllib.request.Request(
        VIBE + path,
        headers={"Referer": "https://vibe.naver.com/", "Accept": "application/json",
                 "User-Agent": BROWSER})
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


words = " ".join(sys.argv[1:]) or "성시경"
print(f"검색어 {words!r}")
try:
    found = get(f"/v3/search/track?query={urllib.parse.quote(words)}&start=1&display=8&sort=RELEVANCE")
except Exception as error:
    print(f"  검색 자체가 실패: {type(error).__name__} {error}")
    raise SystemExit(1)

rows = (found.get("response") or {}).get("result", {}).get("tracks") or []
print(f"  트랙 {len(rows)}개")
if not rows:
    print("  응답 꼭대기 열쇠:", list(found))
    print("  response.result 열쇠:", list((found.get("response") or {}).get("result") or {}))
    print("  앞부분:", json.dumps(found, ensure_ascii=False)[:400])
    raise SystemExit

for track in rows[:6]:
    name = f"{track.get('trackTitle')}"
    try:
        got = get(f"/v3/lyric/{track.get('trackId')}")
    except Exception as error:
        print(f"  ✗ {name[:26]:<28} 가사 요청 실패 {type(error).__name__}")
        continue
    lyric = (got.get("response") or {}).get("result", {}).get("lyric") or {}
    sync = lyric.get("syncLyric") or {}
    times = sync.get("startTimeIndex")
    parts = sync.get("contents")
    if not times or not parts:
        print(f"  ✗ {name[:26]:<28} hasSync={lyric.get('hasSyncLyric')} "
              f"times={type(times).__name__} contents={type(parts).__name__} · lyric 열쇠 {list(lyric)}")
        continue
    body = next((p.get("text") for p in parts if p.get("languageType") == "default"),
                (parts[0].get("text") if parts else None)) or []
    print(f"  ✓ {name[:26]:<28} 시각 {len(times)} · 글 {len(body)}")
