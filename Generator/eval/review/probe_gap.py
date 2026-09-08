#!/usr/bin/env python3
"""**쉼 뒤에 목소리가 다시 나는 자리로 줄 시작을 잰다.** 리드 갈래의 소리가 곡 평균보다 `GAP_DB` 아래로
`GAP_MS` 넘게 내려앉았다가 다시 올라오는 자리(쉼의 끝)를 모두 찾고, 줄마다 지금 머리 근처(앞 `BEFORE_MS`
~ 뒤 `AFTER_MS`)에 그런 자리가 있으면 그것을 소리가 말하는 줄 시작으로 본다. 촘촘한 솟음과 달리 쉼의
끝은 우연히 맞는 일이 드물다 — 야해 첫 줄이 그 예다(무음 → 24.8 초).

@example
  ./.venv/bin/python probe_gap.py 12
"""
import glob
import json
import os
import sqlite3
import sys
import urllib.request

sys.path.insert(0, ".")
import align  # noqa: E402

GAP_DB = 18.0
GAP_MS = 250
BEFORE_MS = 1500
AFTER_MS = 800


def gap_ends(stem: "align.Path") -> list[tuple[int, int]]:
    """Every rest of the stem as (start, end) in ms — quieter than the song by `GAP_DB` for `GAP_MS`.

    @param {Path} stem - The audio to read.
    @returns {list[tuple[int, int]]} Rests, ascending.
    """
    import torch
    wave = align.read_audio(stem, 16_000, 1)[0]
    hop = 16_000 * align.HOP_MS // 1000
    pad = torch.nn.functional.pad(wave.unsqueeze(0).unsqueeze(0), (hop, hop))
    loud = torch.nn.functional.avg_pool1d(pad.pow(2), kernel_size=hop * 2, stride=hop)[0, 0].sqrt()
    floor = float(wave.pow(2).mean().sqrt()) * (10 ** (-GAP_DB / 20))
    out: list[tuple[int, int]] = []
    since = None
    for at, one in enumerate(loud.tolist()):
        if one < floor:
            since = at if since is None else since
        elif since is not None:
            if (at - since) * align.HOP_MS >= GAP_MS:
                out.append((since * align.HOP_MS, at * align.HOP_MS))
            since = None
    return out


def main() -> int:
    """Print, per line, the current head, the heard head, and the rest-end nearest the head.

    @returns {int} 0 always.
    """
    conn = sqlite3.connect(os.environ.get("MORA_DB", "review.db"))
    conn.row_factory = sqlite3.Row
    song_id = int(sys.argv[1]) if len(sys.argv) > 1 else 12
    row = conn.execute("SELECT * FROM songs WHERE id=?", (song_id,)).fetchone()
    lines = json.loads(row["lines"])
    found = align.source_in(align.Path("audio"), row["video_id"])
    lead = found.parent / (found.name.rsplit(".", 1)[0] + ".lead.wav")
    rests = gap_ends(lead)
    print(f"  쉼 {len(rests)} 개 (−{GAP_DB:.0f} dB · {GAP_MS} ms 넘게)")
    got = json.load(urllib.request.urlopen(f"http://127.0.0.1:8787/api/songs/{song_id}"))
    heard = align.kept(align.beside(found, ".heard.json"))
    said = heard["낱말"] if heard else []
    anchored = 0
    for index, line in enumerate(got["lines"]):
        words = line.get("words") or []
        if not words:
            continue
        head = words[0]["at"]
        near = [b for a, b in rests if head - BEFORE_MS <= b <= head + AFTER_MS]
        pick = min(near, key=lambda b: abs(b - head)) if near else None
        first = align.grains_of(align.speakable(words[0]["text"]))
        heard_head = next((at for word, at in said if head - 2000 <= at <= head + 1500
                           and align.jamo_of([(word, 0)])[0][:2] == align.jamo_of([(words[0]["text"], 0)])[0][:2]), None)
        anchored += pick is not None
        print(f"  [{index:>2}] 머리 {head / 1000:6.2f}  쉼 끝 {(pick / 1000) if pick else '  —  ':>6}"
              f"  들음 {(heard_head / 1000) if heard_head else '  —  ':>6}  {line['text'][:18]}")
    print(f"  앞에 쉼이 있는 줄 {anchored}/{len(got['lines'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
