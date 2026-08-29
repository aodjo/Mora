#!/usr/bin/env python3
"""
한국어 정답을 LRCLIB 에서 넓게 긁는다.

지금 한국어 정답은 다섯 곡이다. 영어 스물아홉 곡이 만든 숫자로 한국어 제품을 몰고 있다는
뜻이고, 그 다섯 곡으로는 "한국어가 영어보다 나쁜가"조차 말할 수 없다.

곡 이름을 하나씩 물었을 때(`truth.py`) 마흔 곡 중 다섯 곡만 건졌다. 걸린 자리는 곡이 없는
것이 아니었다 — 스물한 곡이 LRCLIB 에 있었고 열여덟 곡에 싱크가 있었다. **그중 열세 곡이
로마자로 적혀 있었다.** 제품은 멜론·지니에서 한글 원문을 받으므로 로마자 시트로 재면
파이프라인이 아니라 자료를 재게 된다(`truth.romanized` 참고).

그러니 수확률 12% 를 전제로 넓게 긁는다. 검색 API 는 한 번에 스무 건을 주므로 씨앗을 여럿
던져 모은 뒤 걸러 낸다.

video_id 는 여기서 채우지 않는다. 유튜브에 묻는 일은 음원을 받는 기계에서 하는 것이 맞고
(`resolve.py`), 집 아이피로 수십 번 두드릴 일도 아니다.

    python3 Generator/eval/korean.py --want 60 --out korean-candidates.json
"""
from __future__ import annotations

import argparse
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

SEARCH = "https://lrclib.net/api/search"
AGENT = "Mora/0.1 (https://mora.junx.dev)"
STAMP = re.compile(r"^\[(\d{2}):(\d{2})[.:](\d{2,3})\]\s*(.*)$")

# 씨앗. 아티스트 이름이 그 사람의 목록을 통째로 끌어온다. 결과가 스무 건으로 잘리므로
# 이름이 많을수록 낫다 — 발라드·아이돌·힙합·인디·트로트를 고루 섞는다.
SEEDS = [
    "아이유", "임영웅", "성시경", "박효신", "이수현", "악뮤", "볼빨간사춘기", "폴킴",
    "십센치", "10CM", "잔나비", "혁오", "검정치마", "새소년", "실리카겔", "쏜애플",
    "다비치", "태연", "아이브", "뉴진스", "르세라핌", "에스파", "레드벨벳", "트와이스",
    "방탄소년단", "세븐틴", "스트레이키즈", "엔하이픈", "투모로우바이투게더", "NCT",
    "지코", "다이나믹듀오", "에픽하이", "빈지노", "이센스", "박재범", "크러쉬", "딘",
    "선우정아", "이하이", "헤이즈", "청하", "백예린", "죠지", "카더가든", "적재",
    "김광석", "이문세", "신승훈", "김범수", "나훈아", "장윤정", "송가인", "영탁",
    "멜로망스", "너드커넥션", "루시", "데이식스", "엔플라잉", "체리필터", "자우림",
    "윤하", "거미", "알리", "린", "정승환", "김나영", "규현", "황치열",
    "최유리", "한로로", "우디", "로이킴", "도경수", "WOODZ", "코르티스", "NMIXX",
]

HANGUL = re.compile(r"[가-힣]")
# 업로더가 제목 칸에 넣어 둔 것들. 이대로 유튜브에 물으면 엉뚱한 것을 받는다.
JUNK = re.compile(r"가사|lyrics|\{|\}|\[|\]|\bMV\b|official", re.I)
# 반주·노래방 판. 보컬이 없으므로 받아 봐야 앵커가 하나도 안 붙는다 — 그 결과는 "정렬이
# 나쁘다"로 읽히지 "노래가 없는 음원을 받았다"로는 읽히지 않는다. 여기서 버린다.
NO_VOICE = re.compile(r"\(\s*inst\.?\s*\)|instrumental|\bMR\b|karaoke|반주|노래방", re.I)
# 앨범 목록에서 긁힌 트랙 번호. 「602. 짠짜라」의 602 는 곡 이름이 아니다.
TRACK_NUMBER = re.compile(r"^\s*\d{1,4}\s*[.\-]\s*(?=\S)")


def get(query: str) -> list[dict]:
    url = f"{SEARCH}?{urllib.parse.urlencode({'q': query})}"
    request = urllib.request.Request(url, headers={"User-Agent": AGENT})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                got = json.loads(response.read().decode("utf-8"))
                return got if isinstance(got, list) else []
        except Exception:
            if attempt == 3:
                return []
            time.sleep(2 * (attempt + 1))
    return []


def parse(synced: str) -> list[dict]:
    """[mm:ss.xx] 줄들을 (시각 ms, 글자) 로. 글자가 빈 줄은 간주 표시라 버린다."""
    rows = []
    for line in synced.splitlines():
        hit = STAMP.match(line.strip())
        if not hit:
            continue
        text = hit.group(4).strip()
        if not text:
            continue
        fraction = hit.group(3)
        milli = int(fraction) * (10 if len(fraction) == 2 else 1)
        rows.append({"at": int(hit.group(1)) * 60_000 + int(hit.group(2)) * 1_000 + milli, "text": text})
    return rows


def korean_enough(text: str) -> bool:
    """한글로 적힌 시트인가. 로마자로 옮겨 적은 것은 정답 자리에 두지 않는다."""
    hangul = len(HANGUL.findall(text))
    latin = sum(1 for character in text if character.isascii() and character.isalpha())
    return hangul > latin


def usable(item: dict, least_lines: int, seed: str) -> dict | None:
    synced = item.get("syncedLyrics") or ""
    if not synced:
        return None
    lines = parse(synced)
    if len(lines) < least_lines:
        return None
    body = " ".join(row["text"] for row in lines)
    if not korean_enough(body):
        return None
    # 제목이 한글이 아니어도 가사가 한글이면 한국 노래다 — 「Popcorn」, 「BAD」 같은 것들.
    duration = item.get("duration")
    if not duration or duration < 60 or duration > 600:
        return None
    artist = (item.get("artistName") or "").strip()
    if not artist or not by_this_artist(artist, seed):
        return None
    raw_title = (item.get("trackName") or "").strip()
    if str(item.get("instrumental")).lower() == "true" or NO_VOICE.search(raw_title):
        return None
    title = clean_title(raw_title, artist)
    if not title or JUNK.search(title):
        return None
    # 마지막 줄이 곡보다 늦게 시작할 수는 없다. 그런 항목은 길이가 다른 판의 것이거나
    # 시트가 아예 다른 곡의 것이다 — 예순일곱 곡 중 여섯 곡이 그랬다.
    if lines[-1]["at"] / 1000 > duration:
        return None
    return {"artist": artist, "title": title, "language": "ko", "duration": duration, "lines": lines}


def by_this_artist(artist: str, seed: str) -> bool:
    """내가 물어본 그 사람의 행인가.

    LRCLIB 은 올린 사람의 파일 태그를 검수 없이 저장한다. 「지코」로 물으면 이런 것이 1 위로
    온다 — `artistName="Hamah Music", trackName="지코 아무노래", albumName="지코 아무노래"`.
    올린 사람의 태그에 유튜브 채널 이름이 들어 있던 것이다. `q=` 는 세 칸을 통째로 훑으므로
    앨범 칸에 걸려 올라온다. (`artist_name=` 으로 아티스트 칸만 보는 길은 검색 엔드포인트가
    지원하지 않는다 — 0 건이 온다.)

    고치려 들 것이 아니라 **아티스트 칸에 내가 물어본 이름이 실제로 있는 행만** 받으면 된다.
    같은 결과 안에 「지코(ZICO)」와 「지코」가 멀쩡히 함께 있다. 표기가 갈린 것은 통과한다 —
    「AKMU (악뮤)」, 「IU (아이유)」, 「Lim Young Woong (임영웅)」 모두 속에 씨앗이 들어 있다.
    """
    return artist_core(seed) in artist_core(artist)


def clean_title(title: str, artist: str) -> str:
    """업로더가 제목 칸에 넣어 둔 아티스트 이름과 군더더기를 떼어 낸다.

    `(Feat. ...)` 는 남긴다. 곡 이름의 일부이고, 유튜브에 물을 때 오히려 도움이 된다.
    """
    core = artist_core(artist)
    title = TRACK_NUMBER.sub("", title)
    # 「AKMU (악뮤) - 소문의 낙원」 처럼 아티스트가 앞에 붙은 것.
    head, _, tail = title.partition(" - ")
    if tail and artist_core(head) == core:
        title = tail
    # 「602. 짠짜라 - 장윤정」 처럼 뒤에 붙은 것.
    head, sep, tail = title.rpartition(" - ")
    if sep and artist_core(tail) == core:
        title = head
    return title.strip()


def artist_core(name: str) -> str:
    """표기가 갈린 같은 사람을 하나로 본다 — 「악뮤」와 「AKMU (악뮤)」는 같다."""
    hangul = "".join(HANGUL.findall(name))
    return hangul or re.sub(r"[^a-z0-9]", "", name.lower())


def key(row: dict) -> str:
    """같은 곡을 두 번 재지 않는다. 아티스트 표기와 괄호 딸림말은 무시한다."""
    title = re.sub(r"[\(（].*?[\)）]", "", row["title"])
    title = re.sub(r"[^0-9a-z가-힣]", "", title.lower())
    return f"{artist_core(row['artist'])}|{title}"


def spread(rows, want: int) -> list[dict]:
    """한 사람이 목록을 채우지 않게 아티스트를 돌아가며 뽑는다.

    씨앗마다 상한을 두어도 표기가 갈린 같은 사람(「악뮤」와 「AKMU (악뮤)」)이 여러 씨앗에
    걸리면 다시 쏠린다. 마지막에 한 번 더 고른다.
    """
    buckets: dict[str, list[dict]] = {}
    for row in sorted(rows, key=lambda r: (r["artist"], r["title"])):
        buckets.setdefault(artist_core(row["artist"]), []).append(row)
    picked: list[dict] = []
    while len(picked) < want:
        moved = False
        for bucket in buckets.values():
            if not bucket:
                continue
            picked.append(bucket.pop(0))
            moved = True
            if len(picked) >= want:
                break
        if not moved:
            break
    return sorted(picked, key=lambda r: (r["artist"], r["title"]))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--want", type=int, default=60, help="마지막에 몇 곡을 남길까")
    parser.add_argument("--per-seed", type=int, default=3, help="씨앗 하나에서 몇 곡까지 받을까")
    parser.add_argument("--least-lines", type=int, default=15)
    parser.add_argument("--out", default="korean-candidates.json")
    parser.add_argument("--exclude", default="", help="이미 쟀으므로 빼는 곡 목록(json)")
    args = parser.parse_args()

    skip = set()
    if args.exclude and Path(args.exclude).exists():
        for row in json.loads(Path(args.exclude).read_text(encoding="utf-8")):
            skip.add(key({"artist": row.get("artist", ""), "title": row.get("title", "")}))

    found: dict[str, dict] = {}
    asked = 0
    # 씨앗을 다 돈다. 앞의 여덟에서 예순한 곡을 채우고 멈춘 판이 있었는데, 그 예순한 곡이
    # 발라드 가수 여덟 명의 것이었다 — 아이돌도 힙합도 트로트도 없었다. 오토튠과 랩이
    # 정렬이 깨지는 자리이므로, 그 표본으로 낸 숫자는 실제보다 좋게 나온다.
    for seed in SEEDS:
        items = get(seed)
        asked += len(items)
        before = len(found)
        taken = 0
        for item in items:
            row = usable(item, args.least_lines, seed)
            if row is None or key(row) in skip:
                continue
            # 같은 곡이 두 판으로 오면 줄이 많은 쪽을 남긴다 — 짧은 쪽은 잘린 시트다.
            kept = found.get(key(row))
            if kept is not None:
                if len(row["lines"]) > len(kept["lines"]):
                    found[key(row)] = row
                continue
            if taken >= args.per_seed:
                continue
            found[key(row)] = row
            taken += 1
        print(f"  {seed:<12} +{len(found) - before:<2}  (모두 {len(found)}곡)", flush=True)
        time.sleep(0.2)

    rows = spread(found.values(), args.want)
    Path(args.out).write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    total = sum(len(r["lines"]) for r in rows)
    print(f"\n  물어본 {asked}건 중 쓸 만한 {len(rows)}곡 · 줄 {total}개 → {args.out}")
    if rows:
        # 사람이 찍은 것이라 붙어 있는 줄이 섞인다. 0.3 초 미만 간격은 한 호흡에 두 줄이다.
        tight = sum(1 for r in rows for i in range(len(r["lines"]) - 1)
                    if r["lines"][i + 1]["at"] - r["lines"][i]["at"] < 300)
        print(f"  0.3 초 안에 붙은 줄 {tight}개 ({tight / max(1, total):.0%}) — 이만큼은 자 자체가 흐리다")


if __name__ == "__main__":
    main()
