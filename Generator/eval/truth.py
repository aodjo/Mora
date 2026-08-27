#!/usr/bin/env python3
"""
LRCLIB 에서 줄 시작 시각을 받아 정답셋으로 만든다.

오늘 하루 잰 것은 전부 대리 지표였다 — 앵커 밀도, 숨 자리 비율, 구절 수. 정답을 모르니
"좋아졌나"를 물으면 매번 "아마도"로 끝났다. 줄 시작 시각이 있으면 "평균 180 ms 틀렸다"고
말할 수 있다.

한계를 먼저 적는다. LRC 는 사람이 손으로 찍은 것이라 그 자체가 ±수백 ms 흔들린다. 그러니
이 자로 잴 수 있는 것은 "크게 어긋났나"이지 "10 ms 정확한가"가 아니다. 그래도 지금 우리에게
있는 것은 이것뿐이고, 없는 것보다 비교할 수 없이 낫다.
"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://lrclib.net/api/get"
AGENT = "Mora/0.1 (https://mora.junx.dev)"
STAMP = re.compile(r"^\[(\d{2}):(\d{2})[.:](\d{2,3})\]\s*(.*)$")
HERE = Path("/private/tmp/claude-501/-Users-aodjo-Documents/902c1ab8-d352-459a-8ead-dbbe40362867/scratchpad")


def ask(artist: str, title: str) -> dict | None:
    query = urllib.parse.urlencode({"artist_name": artist, "track_name": title})
    request = urllib.request.Request(f"{API}?{query}", headers={"User-Agent": AGENT})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception:
        return None


def parse(synced: str) -> list[dict]:
    """[mm:ss.xx] 줄들을 (시각 ms, 글자) 로. 글자가 빈 줄은 간주 표시라 버린다."""
    out = []
    for row in synced.splitlines():
        found = STAMP.match(row.strip())
        if not found:
            continue
        minute, second, fraction, text = found.groups()
        milli = int(fraction) * (10 if len(fraction) == 2 else 1)
        if text.strip():
            out.append({"at": int(minute) * 60000 + int(second) * 1000 + milli, "text": text.strip()})
    return out


def main() -> None:
    songs = json.loads(Path("Generator/eval/songs.json").read_text(encoding="utf-8"))
    truth = []
    for song in songs:
        if song["language"] != "ko":
            continue
        result = ask(song["artist"], song["title"])
        synced = (result or {}).get("syncedLyrics") or ""
        lines = parse(synced) if synced else []
        if len(lines) < 5:
            continue
        truth.append({
            "video_id": song["video_id"], "artist": song["artist"], "title": song["title"],
            "duration": (result or {}).get("duration"), "lines": lines,
        })
        gap = [lines[i + 1]["at"] - lines[i]["at"] for i in range(len(lines) - 1)]
        print(f"  {len(lines):>3}줄  {min(gap) / 1000:>5.1f}~{max(gap) / 1000:<5.1f}초 간격  "
              f"{song['artist'][:14]:<16}{song['title'][:26]}")
        time.sleep(0.15)

    (HERE / "truth.json").write_text(json.dumps(truth, ensure_ascii=False), encoding="utf-8")
    total = sum(len(t["lines"]) for t in truth)
    print(f"\n  정답 {len(truth)}곡 · 줄 {total}개")
    # 사람이 찍은 것이라 붙어 있는 줄이 섞인다. 0.3 초 미만 간격은 한 호흡에 두 줄을 찍은 것.
    tight = sum(1 for t in truth for i in range(len(t["lines"]) - 1)
                if t["lines"][i + 1]["at"] - t["lines"][i]["at"] < 300)
    print(f"  0.3 초 안에 붙은 줄 {tight}개 ({tight / max(1, total):.0%}) — 이만큼은 자 자체가 흐리다")


if __name__ == "__main__":
    main()
