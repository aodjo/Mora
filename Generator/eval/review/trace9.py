#!/usr/bin/env python3
"""**붉은 노을 한 곡, 줄 몇 개를 단계마다 따라간다.** 리드에 멀쩡한 후보가 있는 줄이 왜 잔해로
끝나는지 — 재시도가 버렸는지, 뒤 단계(시계·펴기·다듬기)가 다시 뭉갰는지.

`align_song` 을 감싸 갈래마다의 결과와 그때의 `out` 상태를 찍고, 뒤 단계들을 감싸 앞뒤를 찍는다.
`align_voices` 는 이 이름들을 모듈 전역으로 부르므로 감싸면 안에서도 감싸인 것이 돈다. 첫
`align_song` 의 반환값이 곧 `out` 이라 그 참조를 잡아 둔다.

@example
  MORA_TRACE=1,3,21 ./.venv/bin/python trace9.py
"""
import json
import os
import re
import sqlite3
import sys

sys.path.insert(0, ".")
import align  # noqa: E402

NOT = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")
TARGET = [int(one) for one in os.environ.get("MORA_TRACE", "1,3,17,21,24,30").split(",") if one.strip()]
SONG = int(os.environ.get("MORA_SONG", "9"))


def words_of(text: str) -> list[str]:
    """Split a line into the words the aligner uses, dropping marks that carry no sound.

    @param {str} text - One lyric line.
    @returns {list[str]} Words worth aligning.
    """
    return [one for one in text.split() if one and not NOT.match(one)]


def health(rows: list[dict]) -> int:
    """Same grading the retry loop uses, copied so the trace says what it saw.

    @param {list[dict]} rows - Characters of one line.
    @returns {int} 0 forced through a mask, 1 whole-line uniform, 2 packed/flattened, 3 clean.
    """
    if not rows:
        return -1
    if min((one.get("sure", 0.0) for one in rows), default=0.0) <= -1000:
        return 0
    gaps = [b["at"] - a["at"] for a, b in zip(rows, rows[1:])]
    if len(gaps) >= 2 and max(gaps) - min(gaps) <= 3:
        return 1
    return 2 if align.packed_run(rows) or any(one.get("flat") for one in rows) else 3


def line_of(words: list[dict]) -> str:
    """One-line summary of a line's characters.

    @param {list[dict]} words - The line's words.
    @returns {str} Span, gap range, health, min sureness, flat stamps.
    """
    chars = [one for word in words for one in (word.get("chars") or []) if one.get("at") is not None]
    if not chars:
        return "없음" + (" (stuck)" if words and words[0].get("stuck") else "")
    gaps = [b["at"] - a["at"] for a, b in zip(chars, chars[1:])]
    flat = {one.get("flat") for one in chars if one.get("flat")}
    sure = min(one.get("sure", 0.0) for one in chars)
    return (f"{chars[0]['at'] / 1000:6.2f}~{chars[-1]['at'] / 1000:6.2f} 간격 {min(gaps) if gaps else 0:>4}~{max(gaps) if gaps else 0:<4}"
            f" 등급 {health(chars)} sure {sure:7.1f} {'/'.join(sorted(flat)) or '-':<6} n{len(chars)}")


CHARS = [int(one) for one in os.environ.get("MORA_CHARS", "").split(",") if one.strip()]


def snap(tag: str, out: list[list[dict]]) -> None:
    """Print the target lines' state under a tag, and every character of the `MORA_CHARS` lines.

    @param {str} tag - Stage name.
    @param {list[list[dict]]} out - Per-line words.
    """
    for index in TARGET:
        if index < len(out):
            print(f"  {tag:<16} [{index:>2}] {line_of(out[index])}")
            if index in CHARS:
                chars = [one for word in out[index] for one in (word.get("chars") or []) if one.get("at") is not None]
                print("      " + " ".join(f"{one.get('ch') or one.get('char') or '?'}{one['at'] / 1000:.2f}/{one.get('sure', 0):.0f}"
                                          for one in chars))


def main() -> int:
    """Run align_voices on song 9 with every stage wrapped.

    @returns {int} 0 always.
    """
    conn = sqlite3.connect(os.environ.get("MORA_DB", "review.db"))
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM songs WHERE id=?", (SONG,)).fetchone()
    lines = json.loads(row["lines"])
    found = align.source_in(align.Path("audio"), row["video_id"])
    for index in TARGET:
        print(f"  [{index:>2}] {lines[index].get('at')}  {lines[index]['text']}")

    state: dict = {"out": None, "n": 0}
    real_align = align.align_song

    def traced_align(stem, *args, **kwargs):
        kind = stem.name.rsplit(".", 2)[-2] if stem.name.count(".") >= 2 else "원본"
        got = real_align(stem, *args, **kwargs)
        state["n"] += 1
        #: `clearest` 도 `align_song` 을 부르므로 첫 반환값이 `out` 이 아니다. 부른 쪽이
        #: `align_voices` 인 첫 결과가 `out` 이다.
        if state["out"] is None and sys._getframe(1).f_code.co_name == "align_voices":
            state["out"] = got
            print(f"\n== align_song #{state['n']} {kind} (바탕)")
            snap("바탕", got)
            return got
        blank = sum(1 for one in args[0] if not one.get("text"))
        print(f"\n== align_song #{state['n']} {kind}" + (f" (빈 줄 {blank})" if blank else ""))
        for index in TARGET:
            if index < len(got):
                if state["out"] is not None:
                    print(f"  {'지금 out':<16} [{index:>2}] {line_of(state['out'][index])}")
                print(f"  {'후보 ' + kind:<16} [{index:>2}] {line_of(got[index])}")
        return got

    align.align_song = traced_align

    def wrap(name: str, where: int):
        real = getattr(align, name)

        def traced(*args, **kwargs):
            out = args[where]
            print(f"\n== {name} 앞")
            snap("앞", out)
            result = real(*args, **kwargs)
            print(f"== {name} 뒤")
            snap("뒤", out)
            return result
        setattr(align, name, traced)

    for name, where in (("split_runs", 2), ("settle_lanes", 0), ("settle_clock", 1), ("unpack_song", 0),
                        ("polish", 2), ("settle_heard", 2), ("settle_rests", 2), ("settle_turns", 2), ("hush_tails", 0)):
        wrap(name, where)

    real_order = align.in_order

    def traced_order(out, index, now):
        ok = real_order(out, index, now)
        if index in TARGET:
            print(f"  {'in_order':<16} [{index:>2}] {'통과' if ok else '차례 어긋남'}  {now[0]['at'] / 1000:.2f}~{now[-1]['at'] / 1000:.2f}")
        return ok
    align.in_order = traced_order

    out, _ = align.align_voices(found, lines, words_of, row["title"])
    print("\n== 끝")
    snap("끝", out)

    flat_ids: list[int] = []
    off_ids: list[tuple[int, float]] = []
    for index, words in enumerate(out):
        chars = [one for word in words for one in (word.get("chars") or []) if one.get("at") is not None]
        if len(chars) >= 3 and health(chars) == 1:
            flat_ids.append(index)
        outside = lines[index].get("at")
        if chars and outside is not None and abs(chars[0]["at"] - outside) > 1000:
            off_ids.append((index, (chars[0]["at"] - outside) / 1000))
    print(f"\n{row['title']} 줄 {len(out)} · 균일 {len(flat_ids)} {flat_ids} · 1초 넘게 어긋남 {len(off_ids)} "
          + " ".join(f"[{index}]{off:+.2f}" for index, off in off_ids))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
