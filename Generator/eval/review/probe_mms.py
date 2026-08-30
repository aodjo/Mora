#!/usr/bin/env python3
"""MMS_FA 와 지금 쓰는 한국어 CTC 모델을 **같은 자로** 견준다.

MMS_FA 는 애초에 강제 정렬용으로 만들어진 것이라 노래에 더 견딜 수 있다. 다만 어휘가
로마자 스물아홉 자뿐이라 한글을 로마자로 옮겨 넣어야 한다(uroman).

자는 하나다 — **줄 시작을 바이브가 준 시각과 견준 오차.** 확신도 같은 것은 두 모델의
값이 서로 다른 뜻이라 견줄 수가 없다.
"""
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

import torch
import torchaudio
import torchaudio.functional as F

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402

NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")


def words_of(text: str) -> list[str]:
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def mms_align(path: Path, lines: list[dict]) -> list[int | None]:
    """줄마다 첫 글자가 언제 시작하는지. 못 맞추면 None."""
    import uroman as ur

    bundle = torchaudio.pipelines.MMS_FA
    model = bundle.get_model().eval()
    where = align.device()
    model = model.to(where)
    table = bundle.get_dict()
    roman = ur.Uroman()

    audio = align.read_audio(align.vocals_of(path))
    voice = audio.to(torch.float32)
    voice = (voice - voice.mean()) / (voice.std() + 1e-7)

    #: 조각내어 추론하고 이어 붙인다. 지금 쓰는 것과 같은 방식이라야 견줄 수 있다.
    stride, pieces, at = 320, [], 0
    step = (30 * align.SAMPLE_RATE // stride) * stride
    edge = (2 * align.SAMPLE_RATE // stride) * stride
    while at < voice.shape[-1]:
        stop = min(voice.shape[-1], at + step)
        left, right = max(0, at - edge), min(voice.shape[-1], stop + edge)
        with torch.inference_mode():
            got = model(voice[..., left:right].to(where))[0].cpu()
        head, tail = (at - left) // stride, (right - stop) // stride
        pieces.append(got[:, head: got.shape[1] - tail if tail else None])
        at = stop
    log_probs = torch.log_softmax(torch.cat(pieces, dim=1), dim=-1)

    #: 한글을 로마자로 옮겨 어휘에 넣는다. 줄마다 첫 토큰이 몇 번째인지 기억해 둔다.
    tokens: list[int] = []
    firsts: list[int | None] = []
    for line in lines:
        made = None
        for word in words_of(line.get("text", "")):
            for letter in roman.romanize_string(word).lower():
                if letter in table:
                    if made is None:
                        made = len(tokens)
                    tokens.append(table[letter])
        firsts.append(made)
    if not tokens or len(tokens) > log_probs.shape[1]:
        return [None] * len(lines)

    paths, scores = F.forced_align(log_probs, torch.tensor([tokens]), blank=0)
    merged = F.merge_tokens(paths[0], scores[0], blank=0)
    if len(merged) != len(tokens):
        return [None] * len(lines)
    per_frame = voice.shape[-1] / log_probs.shape[1] / align.SAMPLE_RATE * 1000
    return [None if one is None else int(merged[one].start * per_frame) for one in firsts]


def score(name: str, ours: list[int | None], lines: list[dict]) -> None:
    gaps = [one - lines[i]["at"] for i, one in enumerate(ours)
            if one is not None and lines[i].get("at") is not None]
    if not gaps:
        print(f"    {name:<10} 맞춘 줄 없음")
        return
    ranked = sorted(gaps)
    mid = ranked[len(ranked) // 2]
    off = sorted(abs(one - mid) for one in gaps)
    print(f"    {name:<10} {len(gaps):>3}줄 · 치우침 {mid / 1000:+.2f}s · "
          f"오차 {off[len(off) // 2]:>4.0f}ms · p90 {off[int(len(off) * 0.9)]:>5.0f}ms · "
          f"0.3초 초과 {sum(1 for one in off if one > 300)}줄")


conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
how_many = int(sys.argv[1]) if len(sys.argv) > 1 else 3
for row in conn.execute("SELECT id, artist, title, video_id, lines FROM songs ORDER BY id").fetchall()[:how_many]:
    found = sorted(p for p in (HERE / "audio").glob(f"{row['video_id']}.*")
                   if p.suffix != ".part" and not p.name.endswith(".vocals.wav"))
    if not found:
        continue
    lines = json.loads(row["lines"])
    print(f"\n  {row['artist'][:14]} — {row['title'][:24]} · 줄 {len(lines)}")

    began = time.time()
    got = align.align_song(found[0], lines, words_of)
    mine = [one[0]["at"] if one else None for one in got]
    score(f"한국어({time.time() - began:.0f}초)", mine, lines)

    began = time.time()
    try:
        theirs = mms_align(found[0], lines)
        score(f"MMS_FA({time.time() - began:.0f}초)", theirs, lines)
    except Exception as error:
        print(f"    MMS_FA     실패: {type(error).__name__}: {str(error)[:120]}")
