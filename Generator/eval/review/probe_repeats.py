"""반복 채우기(repeat_fill)가 줄여 적은 가사에서 빠진 반복 줄을 얼마나 되살리고, 없는 반복을 얼마나 지어내는지 잰다.

곡의 가사(바이브, 반복을 풀어 적음)를 정답으로 두고, 이어서 되풀이되는 줄·묶음을 한 번만 남겨 멜론식으로
줄인 것을 넣는다. 되살린 순서를 정답과 줄 단위로 맞춰(가장 긴 공통 부분열) 센다.

  되살림  정답에만 있는 반복 줄 가운데 제자리에 돌아온 것
  지어냄  넣었는데 정답에 없는 줄
  그대로  줄이지 않은 가사를 넣었을 때 넣은 줄 — 전부 지어냄으로 본다(바이브가 흘린 반복일 수도 있다)

받아쓰기는 곡마다 이미 있는 `.heard.json` 을 쓴다. GPU 는 쓰지 않는다.

    python probe_repeats.py review.db 11 ../mora-val2/review.db 20 --cost 1.0,1.5,2.5
"""
from __future__ import annotations

import difflib
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import repeat_fill  # noqa: E402


def key(text: str) -> str:
    """Compare lines by their letters only, the way providers differ in spacing and punctuation.

    @param {str} text - A lyric line.
    @returns {str} Letters and digits, lower-cased.
    """
    return re.sub(r"[^0-9A-Za-z가-힣]", "", text).lower()


def collapse(lines: list[str]) -> list[int]:
    """Indices kept when every run of an immediately repeated line or block is written once.

    A provider that shortens 「A A A B」 to 「A B」, or 「X Y X Y」 to 「X Y」, drops exactly the rest.

    @param {list[str]} lines - Lyric lines as sung.
    @returns {list[int]} The indices a shortening provider would keep.
    """
    keys = [key(one) for one in lines]
    kept: list[int] = []
    index = 0
    while index < len(keys):
        kept.append(index)
        index += 1
        grew = True
        while grew:
            grew = False
            for size in range(1, 9):
                if len(kept) < size:
                    break
                block = [keys[k] for k in kept[-size:]]
                if all(block) and keys[index:index + size] == block:
                    index += size
                    grew = True
                    break
    return kept


def score(order: list[int], given: list[str], truth: list[str]) -> tuple[int, int, int]:
    """Count the lines put back right and the lines made up.

    @param {list[int]} order - What `expand` answered, as indices into `given`.
    @param {list[str]} given - The lines fed in.
    @param {list[str]} truth - The lines as sung.
    @returns {tuple[int, int, int]} Repeats to recover, recovered, made up.
    """
    got = [key(given[k]) for k in order]
    want = [key(one) for one in truth]
    common = sum(block.size for block in difflib.SequenceMatcher(None, got, want, autojunk=False).get_matching_blocks())
    base = len(given)
    return len(truth) - base, max(0, common - base), len(got) - max(common, base)


def songs(db: Path, count: int) -> list[tuple[str, list[str], list[tuple[str, int]], tuple[Path, str]]]:
    """The first `count` songs with a transcript, as probe_par picks them.

    @param {Path} db - A review database beside its `audio` folder.
    @param {int} count - How many songs.
    @returns {list[tuple[str, list[str], list[tuple[str, int]], tuple[Path, str]]]} Title, lines as sung, transcript words, where the audio is.
    """
    picked = []
    rows = sqlite3.connect(db).execute("SELECT id, title, video_id, lines FROM songs ORDER BY id").fetchall()[:count]
    for song_id, title, video, raw in rows:
        lines = json.loads(raw)
        if sum(1 for one in lines if one.get("at") is not None) < 8:
            continue
        heard = db.parent / "audio" / f"{video}.heard.json"
        if not heard.exists():
            print(f"  받아쓰기 없음 [{song_id}] {title}", file=sys.stderr)
            continue
        words = [(word, at) for word, at in json.load(open(heard, encoding="utf-8")).get("낱말") or []]
        picked.append((f"[{song_id}] {title}", [one["text"] for one in lines], words, (db.parent / "audio", video)))
    return picked


def main() -> int:
    """Run every cost on every song and print the totals, then the per-song rows for the first cost.

    @returns {int} 0 always.
    """
    args = sys.argv[1:]
    costs = [2.5]
    if "--cost" in args:
        at = args.index("--cost")
        costs = [float(one) for one in args[at + 1].split(",")]
        del args[at:at + 2]
    ears = "--listen" in args
    if ears:
        args.remove("--listen")
    picked = [song for db, count in zip(args[::2], args[1::2]) for song in songs(Path(db), int(count))]
    print(f"곡 {len(picked)} · 되돌아감 값 {costs}{' · 소리 모델로 가림' if ears else ''}\n")
    for cost in costs:
        repeat_fill.REPEAT = cost
        began = time.time()
        need = back = made = plain_made = with_repeats = 0
        rows = []
        for title, truth, words, (folder, video) in picked:
            listen, until = None, None
            if ears:
                import align
                import soundfile
                from probe_blind import words_of
                found = align.source_in(folder, video)
                stem = found.with_suffix(".lead.wav")
                ears = align.repeat_ears(found, words_of)
                listen = None if ears is None else ears[0]
                until = int(soundfile.info(str(stem)).duration * 1000) if stem.exists() else None
            kept = collapse(truth)
            given = [truth[k] for k in kept]
            a, b, c = score(repeat_fill.expand(given, words, listen, until), given, truth)
            plain = repeat_fill.expand(truth, words, listen, until)
            _, _, d = score(plain, truth, truth)
            need, back, made, plain_made = need + a, back + b, made + c, plain_made + d
            with_repeats += 1 if a else 0
            rows.append((title, a, b, c, d))
        print(f"값 {cost}: 되살림 {back}/{need} ({back / max(1, need) * 100:.0f}%) · 지어냄 {made} · "
              f"그대로 넣었을 때 지어냄 {plain_made} · 반복 있는 곡 {with_repeats} · {time.time() - began:.0f}초")
        for title, a, b, c, d in rows:
            if a or c or d:
                print(f"    {title[:28]:<28} 빠진 반복 {a:>3} · 되살림 {b:>3} · 지어냄 {c:>2} · 그대로 지어냄 {d:>2}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
