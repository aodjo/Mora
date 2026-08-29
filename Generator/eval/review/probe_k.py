#!/usr/bin/env python3
"""**소리만으로 「부르는 사람이 여럿인가」를 알 수 있는가.**

제목의 `Feat.` 에 기대면 그룹(빅뱅·방탄 같은)을 못 잡는다 — 넷다섯이 번갈아 부르는데
제목에는 아무 표시가 없다.

앞서 두 자를 써 봤고 둘 다 실패했다:

* **거리 문턱** — 0.25~0.55 를 훑으니 묶음이 15~47 개로 흩어졌다. ECAPA 는 말로 훈련된
  것이라 노래에서는 같은 사람의 자국도 음높이·창법에 따라 크게 흔들린다.
* **실루엣 점수** — 솔로 곡이 피처링 곡보다 높게 나왔다(0.350 대 0.322). 묶임새는 사람이
  갈리는지가 아니라 **창법이 갈리는지**를 잰다.

여기서 시험하는 세 번째 자는 **덩어리짐**이다. 진짜로 사람이 바뀌면 그 사람이 한 절을
통째로 부르므로 줄 번호가 **이어진 덩어리**로 나온다. 반면 한 사람의 창법 변화는 곡 여기저기에
흩어진다. 그래서 묶음마다 「몇 덩어리로 나뉘는가」와 「덩어리가 평균 몇 줄인가」를 잰다.

정답(사용자가 짚어 줌): Small girl 의 `(If, if I got a …)` 는 다른 사람 — 18·19·20·60·61·62.
제목에 `Feat.` 이 있는 곡은 3·7·8, 없는 곡은 1·2·4·5·6.
"""
import json
import re
import sqlite3
import sys
from pathlib import Path

import torch
from sklearn.cluster import AgglomerativeClustering

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402

NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")
FEATURED = {3, 7, 8}
LEAST_MS = 1000


def words_of(text: str) -> list[str]:
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def _split_runs(where: list[int]) -> list[list[int]]:
    """이어진 덩어리로 쪼갠다."""
    out: list[list[int]] = []
    for one in sorted(where):
        if out and one == out[-1][-1] + 1:
            out[-1].append(one)
        else:
            out.append([one])
    return out


def runs_of(where: list[int]) -> tuple[int, float]:
    """이어진 덩어리가 몇 개이고 평균 몇 줄인가."""
    if not where:
        return 0, 0.0
    got = sorted(where)
    runs = 1
    for a, b in zip(got, got[1:]):
        if b != a + 1:
            runs += 1
    return runs, len(got) / runs


from speechbrain.inference.speaker import EncoderClassifier  # noqa: E402

model = EncoderClassifier.from_hparams(
    source="speechbrain/spkrec-ecapa-voxceleb",
    savedir=str(HERE / "models/ecapa"), run_opts={"device": align.device()})

conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
rows = conn.execute("SELECT id, artist, title, video_id, lines FROM songs ORDER BY id").fetchall()
how_many = int(sys.argv[1]) if len(sys.argv) > 1 else 8
k = int(sys.argv[2]) if len(sys.argv) > 2 else 3

print(f"  k={k} · 덩어리짐으로 가른다 — 사람이 바뀌면 이어진 덩어리로 나온다\n")
print(f"  {'곡':<32} {'피처':>4} {'잰 줄':>5} {'0 아닌 묶음의 덩어리':>18} {'가장 긴 덩어리':>12}")
for row in rows[:how_many]:
    found = align.source_in(HERE / "audio", row["video_id"])
    lead = found.with_suffix(".lead.wav") if found else None
    if not lead or not lead.exists():
        continue
    lines = json.loads(row["lines"])
    out = align.align_song(lead, lines, words_of, separate=False)

    audio = align.read_audio(lead)[0]
    least = LEAST_MS / 1000 * align.SAMPLE_RATE
    where, marks = [], []
    with torch.inference_mode():
        for index, words in enumerate(out):
            chars = [one for word in words for one in (word.get("chars") or [])]
            if not chars:
                continue
            since = int(chars[0]["at"] / 1000 * align.SAMPLE_RATE)
            until = int((chars[-1]["end"] or chars[-1]["at"]) / 1000 * align.SAMPLE_RATE)
            if until - since < least or since < 0 or until > audio.shape[-1]:
                continue
            where.append(index)
            marks.append(model.encode_batch(
                audio[since:until].unsqueeze(0).to(align.device())).squeeze().cpu())
    if len(marks) < 8:
        continue
    stack = torch.stack(marks)
    stack = stack / stack.norm(dim=1, keepdim=True).clamp(min=1e-9)
    labels = AgglomerativeClustering(
        n_clusters=k, metric="cosine", linkage="average").fit(stack.numpy()).labels_

    groups: dict[int, list[int]] = {}
    for index, one in zip(where, labels):
        groups.setdefault(int(one), []).append(index)
    order = sorted(groups.values(), key=len, reverse=True)
    # 0 번(가장 큰 묶음)이 아닌 것들이 「다른 사람」 후보다.
    facts = []
    longest = 0
    for one in order[1:]:
        runs, mean = runs_of(one)
        facts.append(f"{len(one)}줄→{runs}덩이(평균 {mean:.1f})")
        best = max((len(g) for g in _split_runs(one)), default=0)
        longest = max(longest, best)
    name = f"[{row['id']}] {row['artist'][:9]} — {row['title'][:14]}"
    mark = "◀" if row["id"] in FEATURED else " "
    print(f"  {name:<32} {mark:>4} {len(where):>5}  {' · '.join(facts):<34} {longest:>6}")
