#!/usr/bin/env python3
"""**밖에서 온 줄 시각을 믿을 만한가.** 사전확률을 넣기 전에 그 전제부터 시험한다.

지금 정렬은 「그럼에도 불구하고」(26번)를 132.92초에 놓는데 바이브는 135.60초라고 한다.
사전확률을 넣는 모든 설계는 **바이브가 옳다**고 전제한다. 그 전제가 틀리면 지금보다
나빠지기만 한다.

그래서 곧바로 묻는다 — 소리를 바이브가 말한 자리 근처로 **좁혀 놓고** 그 줄의 글자만
맞추면, 모델은 거기서 그 글자들을 듣는가? 점수가 높으면 그 소리가 거기 있는 것이고,
낮으면 바이브가 틀렸거나 그 줄이 딴 판에서 온 것이다.

이건 **설계가 아니라 시험**이다. 줄마다 창을 씌우는 것은 이미 실패한 방식이다(창 끝에
글자가 몰린다). 여기서는 「거기 소리가 있나」만 본다.

    probe_prior.py 사랑하게 26
    probe_prior.py 파란달팽이            # 3초 넘게 어긋난 줄을 모두
"""
import json
import re
import sqlite3
import sys
from pathlib import Path

import torch
import torchaudio.functional as F

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402

NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")
# 바이브가 말한 자리 앞뒤로 이만큼 열어 준다. 줄 시각이 조금 틀려도 담기게.
MARGIN_MS = 1500


def words_of(text: str) -> list[str]:
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def tokens_of(text: str) -> tuple[list[int], list[str]]:
    got, grains = [], []
    for word in words_of(text):
        for grain in align.grains_of(align.speakable(word)):
            marks = align.letters(grain)
            if marks:
                got.extend(marks)
                grains.append(grain)
    return got, grains


def score_at(log_probs, tokens: list[int], since: int, until: int) -> tuple[float, int] | None:
    """[since, until) 프레임 안에서만 맞춰 보고 **글자당 평균 점수**와 첫 글자 자리를 준다.

    평균으로 나누는 것은 창마다 길이가 달라서다. 합으로 재면 긴 창이 늘 이긴다.
    """
    piece = log_probs[:, since:until]
    if piece.shape[1] < len(tokens):
        return None
    try:
        paths, scores = F.forced_align(piece, torch.tensor([tokens]), blank=0)
    except Exception:
        return None
    merged = F.merge_tokens(paths[0], scores[0], blank=0)
    if len(merged) != len(tokens):
        return None
    return float(scores[0].sum()) / len(tokens), since + merged[0].start


want = sys.argv[1] if len(sys.argv) > 1 else "사랑하게"
only = int(sys.argv[2]) if len(sys.argv) > 2 else None

conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
row = conn.execute(
    "SELECT id, artist, title, video_id, lines FROM songs WHERE title LIKE ? OR artist LIKE ?",
    (f"%{want}%", f"%{want}%")).fetchone()
if row is None:
    raise SystemExit(f"{want!r} 로 찾히는 곡이 없다")
found = align.source_in(HERE / "audio", row["video_id"])
if not found:
    raise SystemExit("음원이 없다")

lines = json.loads(row["lines"])
audio = align.read_audio(align.vocals_of(found))
log_probs = align.whole_logits(audio)
per_frame = audio.shape[-1] / log_probs.shape[1] / align.SAMPLE_RATE * 1000
whole = align.align_song(found, lines, words_of)

pairs = [(i, one) for i, one in enumerate(whole) if one and lines[i].get("at") is not None]
bias = sorted(one[0]["at"] - lines[i]["at"] for i, one in pairs)[len(pairs) // 2]

# 볼 줄을 고른다. 번호를 주면 그 줄만, 아니면 크게 어긋난 줄을 모두.
picked = [only] if only is not None else [
    i for i, one in pairs if abs(one[0]["at"] - lines[i]["at"] - bias) > 800]

print(f"[{row['id']}] {row['artist']} — {row['title']} · 치우침 {bias / 1000:+.2f}s · 볼 줄 {len(picked)}")
for index in picked:
    line = lines[index]
    tokens, grains = tokens_of(line.get("text", ""))
    if not tokens:
        continue
    ours = whole[index][0]["at"] if whole[index] else None
    said = line["at"] + bias

    # 두 자리를 같은 자로 견준다 — 우리가 고른 자리 vs 바이브가 말한 자리.
    # 창 길이를 똑같이 맞춘다. 다르면 점수가 길이 때문에 갈린다.
    span = max(len(tokens) * 120, 2500) + 2 * MARGIN_MS
    out = []
    for name, middle_ms in (("우리", ours), ("바이브", said)):
        if middle_ms is None:
            out.append((name, None, None))
            continue
        since = max(0, int((middle_ms - MARGIN_MS) / per_frame))
        until = min(log_probs.shape[1], int((middle_ms - MARGIN_MS + span) / per_frame))
        got = score_at(log_probs, tokens, since, until)
        out.append((name, got, middle_ms))

    print(f"\n  {index}번 · {line['text'][:36]!r} · {len(grains)}자")
    for name, got, middle_ms in out:
        if got is None:
            print(f"      {name:<4} 맞출 수 없음")
            continue
        mark, where = got
        print(f"      {name:<4} 창 {(middle_ms - MARGIN_MS) / 1000:>7.2f}s 부터 · "
              f"글자당 점수 {mark:>7.3f} · 첫 글자 {where * per_frame / 1000:>7.2f}s")
    good = [one for one in out if one[1] is not None]
    if len(good) == 2:
        win = max(good, key=lambda one: one[1][0])
        print(f"      → **{win[0]}** 쪽 소리가 더 그럴듯하다 "
              f"(차이 {abs(good[0][1][0] - good[1][1][0]):.3f})")
