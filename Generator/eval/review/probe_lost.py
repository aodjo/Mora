#!/usr/bin/env python3
"""**어느 목소리가 갈래 어디에도 안 들어갔나.**

가르기는 두 번 일어난다 — 먼저 반주를 걷어 `보컬` 을 얻고, 그것을 다시 `리드`/`서브` 로
가른다. 어느 단계에서든 소리가 샐 수 있다:

* 반주 걷기가 어떤 목소리를 **반주로 보고 버리면** 세 갈래 어디에도 안 남는다.
* 카라오케 가르기가 갈피를 못 잡으면 리드와 서브에 **반씩 나뉘어** 둘 다 흐려진다.

줄마다 네 곳의 크기를 견준다 — 원본·보컬·리드·서브. 원본에는 소리가 있는데 보컬이 조용하면
**첫 단계에서 버려진** 것이고, 보컬은 있는데 리드·서브가 둘 다 그보다 훨씬 작으면
**둘째 단계에서 흩어진** 것이다.

`kept` 는 보컬이 원본의 몇 분이나 되는지다. 노래하는 대목의 보컬은 보통 원본의 30~60% 라,
10% 아래면 거의 안 남은 것으로 본다. `held` 는 리드와 서브를 합친 것이 보컬의 몇 분인지다 —
합쳐도 보컬보다 훨씬 작으면 둘째 단계에서 흩어진 것이다.
"""
import json
import re
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import align  # noqa: E402

NOT_A_WORD = re.compile(r"^[♪♫🎵🎶~\-–—…·.,()\[\]{}\"'“”‘’!?]+$")


def words_of(text: str) -> list[str]:
    return [one for one in text.split() if one and not NOT_A_WORD.match(one)]


def loud(wave, since: int, until: int) -> float:
    piece = wave[since:until]
    return float(piece.pow(2).mean().sqrt()) if piece.numel() else 0.0


want = sys.argv[1] if len(sys.argv) > 1 else "Small"
conn = sqlite3.connect(HERE / "review.db")
conn.row_factory = sqlite3.Row
row = conn.execute(
    "SELECT id, artist, title, video_id, lines FROM songs WHERE title LIKE ? OR artist LIKE ?",
    (f"%{want}%", f"%{want}%")).fetchone()
found = align.source_in(HERE / "audio", row["video_id"])
lines = json.loads(row["lines"])

lead_path, back_path = align.voices_of(found)
where = {
    "원본": align.read_audio(found)[0],
    "보컬": align.read_audio(found.with_suffix(".vocals.wav"))[0],
    "리드": align.read_audio(lead_path)[0],
    "서브": align.read_audio(back_path)[0],
}
#: 줄마다 잴 구간. **우리 정렬을 안 쓴다** — 우리가 놓은 자리로 재면, 줄이 엉뚱한
#: 데(간주)에 놓였을 때 「원본은 큰데 보컬이 조용하다」가 나온다. 목소리가 사라진 것이
#: 아니라 간주를 잰 것이다. 밖에서 온 줄 시각을 쓰면 그 혼동이 없다. 다음 줄이 시작할
#: 때까지를 그 줄의 구간으로 본다.
spans: list[tuple[int, int, int]] = []
timed = [(index, one["at"]) for index, one in enumerate(lines) if one.get("at") is not None]
for (index, at), (_, nxt) in zip(timed, timed[1:] + [(None, timed[-1][1] + 4000)]):
    since = int(at / 1000 * align.SAMPLE_RATE)
    until = int(min(nxt, at + 8000) / 1000 * align.SAMPLE_RATE)
    if until - since >= align.SAMPLE_RATE // 2:
        spans.append((index, since, until))

print(f"[{row['id']}] {row['artist']} — {row['title']}")
print("  갈래 전체 크기 — " + " · ".join(
    f"{name} {float(one.pow(2).mean().sqrt()):.4f}" for name, one in where.items()))
print()
print(f"  {'줄':>3} {'원본':>7} {'보컬':>7} {'리드':>7} {'서브':>7}  {'어디로':<12} 글월")

lost, split = [], []
for index, since, until in spans:
    got = {name: loud(one, since, min(until, one.shape[-1])) for name, one in where.items()}

    kept = got["보컬"] / max(got["원본"], 1e-9)
    held = (got["리드"] + got["서브"]) / max(got["보컬"], 1e-9)

    mark = ""
    if kept < 0.10:
        mark = "반주로 버림"
        lost.append(index)
    elif held < 0.55:
        mark = "가르다 샘"
        split.append(index)
    if mark:
        print(f"  {index:>3} {got['원본']:>7.4f} {got['보컬']:>7.4f} {got['리드']:>7.4f} "
              f"{got['서브']:>7.4f}  {mark:<12} {lines[index]['text'][:34]}")

print(f"\n  반주로 버려진 줄 {len(lost)} · 가르다 샌 줄 {len(split)} / 잰 줄 {len(spans)}")
if not lost and not split:
    print("  샌 데가 없다 — 목소리가 사라졌다면 다른 까닭이다")
