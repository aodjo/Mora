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
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://lrclib.net/api/get"
AGENT = "Mora/0.1 (https://mora.junx.dev)"
STAMP = re.compile(r"^\[(\d{2}):(\d{2})[.:](\d{2,3})\]\s*(.*)$")
# 만든 것을 어디에 둘지. 정답에는 가사 글자가 들어 있어 저장소에 커밋하지 않는다.
OUT = Path(os.getenv("MORA_TRUTH", "truth.json"))


def ask(artist: str, title: str) -> dict | None:
    query = urllib.parse.urlencode({"artist_name": artist, "track_name": title})
    request = urllib.request.Request(f"{API}?{query}", headers={"User-Agent": AGENT})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception:
        return None


def romanized(text: str, language: str) -> bool:
    """
    한글로 불리는 노래를 로마자로 적어 둔 시트인가.

    처음 이 평가셋을 냈을 때 열여덟 곡 중 여덟 곡이 그랬다 — 「WOODZ - Drowning」은 한글이
    한 자도 없고 라틴이 931 자였다. 그 시트를 그대로 먹이고 "아이돌과 랩은 받아쓰기가 못
    알아듣는다"고 읽었는데, 제품은 멜론·지니에서 한글 원문을 받으므로 그 실패는 파이프라인의
    성질이 아니라 자료의 결함이었다. 정답으로 쓸 수 없는 것은 정답 자리에 두지 않는다.

    영어 곡은 라틴으로 적힌 것이 원문이므로 여기 걸리지 않는다.
    """
    if language not in ("ko", "ja"):
        return False
    native = sum(1 for c in text if "가" <= c <= "힣" or "぀" <= c <= "ヿ" or "一" <= c <= "鿿")
    latin = sum(1 for c in text if c.isascii() and c.isalpha())
    return latin > native


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
        # 영어 곡은 라틴이 원문이라 로마자 판정에 걸리지 않는다. 함께 재도 된다.
        if song["language"] not in ("ko", "ja", "en"):
            continue
        result = ask(song["artist"], song["title"])
        synced = (result or {}).get("syncedLyrics") or ""
        lines = parse(synced) if synced else []
        if len(lines) < 5:
            continue
        if romanized(" ".join(row["text"] for row in lines), song["language"]):
            print(f"    로마자라 건너뜀  {song['artist'][:14]} - {song['title'][:26]}")
            continue
        truth.append({
            "video_id": song["video_id"], "artist": song["artist"], "title": song["title"],
            # 언어를 실어 보낸다. 재는 쪽이 ko 로 못박아 두었던 판이 있었다 — 일본어 곡이
            # 한국어로 선언되어 정렬기 선택부터 어긋났다.
            "language": song["language"],
            "duration": (result or {}).get("duration"), "lines": lines,
        })
        gap = [lines[i + 1]["at"] - lines[i]["at"] for i in range(len(lines) - 1)]
        print(f"  {len(lines):>3}줄  {min(gap) / 1000:>5.1f}~{max(gap) / 1000:<5.1f}초 간격  "
              f"{song['artist'][:14]:<16}{song['title'][:26]}")
        time.sleep(0.15)

    OUT.write_text(json.dumps(truth, ensure_ascii=False), encoding="utf-8")
    total = sum(len(t["lines"]) for t in truth)
    print(f"\n  정답 {len(truth)}곡 · 줄 {total}개")
    # 사람이 찍은 것이라 붙어 있는 줄이 섞인다. 0.3 초 미만 간격은 한 호흡에 두 줄을 찍은 것.
    tight = sum(1 for t in truth for i in range(len(t["lines"]) - 1)
                if t["lines"][i + 1]["at"] - t["lines"][i]["at"] < 300)
    print(f"  0.3 초 안에 붙은 줄 {tight}개 ({tight / max(1, total):.0%}) — 이만큼은 자 자체가 흐리다")


if __name__ == "__main__":
    main()
