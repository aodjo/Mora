#!/usr/bin/env python3
"""
Tests for the part of the daemon that decides *where in the audio* a lyric line belongs.

Run: python3 Generator/python/test_alignment.py

The forced aligner cannot leave the window it is given, so these windows decide whether the
timings can be right at all. They used to be the vocal region divided by word count.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("daemon", Path(__file__).with_name("mora_ml_daemon.py"))
daemon = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(daemon)

failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    print(f"{'✔' if condition else '✖'} {name}{'' if condition else f'  — {detail}'}")
    if not condition:
        failures.append(name)


def heard(rows: list[tuple[str, float, float]]) -> list[dict[str, object]]:
    return [{"text": daemon.comparable(text), "start": start, "end": end} for text, start, end in rows]


# 실제 사례: Red Velvet "Hawaii". 10.6초 인트로와 3연 앞의 간주가 있다.
LINES = ["내 어릴 적 작은 소망", "멋진 어른이 되는 것", "눈 깜짝할 새 키만 자란", "별난 어른 돼버렸지"]
COUNTS = [len(line.split()) for line in LINES]
WORDS = [daemon.comparable(word) for line in LINES for word in line.split()]
TRUTH = [(10.6, 14.5), (16.0, 20.2), (28.0, 33.0), (34.0, 38.0)]
HEARD = heard([
    ("내", 10.6, 11.0), ("어릴", 11.1, 11.6), ("적", 11.7, 12.0), ("작은", 12.4, 13.2), ("소망", 13.4, 14.5),
    ("멋진", 16.0, 16.6), ("어른이", 16.8, 17.6), ("되는", 18.0, 18.6), ("걸", 19.0, 20.2),  # 오인식: 것 → 걸
    ("눈", 28.0, 28.4), ("깜짝할", 28.6, 29.5), ("새", 29.8, 30.2), ("키만", 30.6, 31.4), ("자란", 31.8, 33.0),
    ("별난", 34.0, 34.6), ("어른", 34.9, 35.5), ("돼버렸지", 36.0, 38.0),
])

windows = daemon.anchored_windows(COUNTS, WORDS, HEARD, 10.6, 38.0)
proportional, _ = daemon.proportional_spans(COUNTS, 10.6, 38.0)

check("어긋난 인식이 있어도 창을 만든다", windows is not None)
assert windows is not None

# 창이 진실을 담고 있어야 정렬기가 그 안에서 단어를 찾을 수 있다.
contained = all(windows[i][0] / 1000 <= TRUTH[i][0] + 0.05 and windows[i][1] / 1000 >= TRUTH[i][1] - 0.05 for i in range(len(TRUTH)))
missed = [i + 1 for i in range(len(TRUTH)) if not (proportional[i][0] / 1000 <= TRUTH[i][0] + 0.05 and proportional[i][1] / 1000 >= TRUTH[i][1] - 0.05)]
check("모든 줄의 창이 실제 발화 구간을 포함한다", contained, f"창={windows} 실제={TRUTH}")
check("기존 비례추정은 포함하지 못한다 (회귀 대비)", len(missed) > 0, "비례추정도 통과하면 이 테스트가 무의미하다")

# 간주 뒤 첫 줄은 비례추정이 가장 크게 빗나가던 자리다.
check(
    "간주 뒤 줄이 간주에 고정되지 않는다",
    abs(windows[2][0] / 1000 - 28.0) < 0.6,
    f"앵커 {windows[2][0] / 1000:.1f}s / 비례 {proportional[2][0] / 1000:.1f}s / 실제 28.0s",
)
check("창은 시간순으로 증가한다", all(windows[i][0] >= windows[i - 1][0] for i in range(1, len(windows))))

# 인식이 거의 안 되면 앵커를 지어내는 대신 물러난다.
check("인식이 부족하면 None을 반환한다", daemon.anchored_windows(COUNTS, WORDS, HEARD[:2], 10.6, 38.0) is None)
check("ASR이 비면 None을 반환한다", daemon.anchored_windows(COUNTS, WORDS, [], 10.6, 38.0) is None)

anchors = daemon.match_sequences(WORDS, HEARD)
check("오인식된 단어는 앵커로 쓰지 않는다", 8 not in anchors, "‘것’이 ‘걸’에 잘못 붙었다")
check("나머지 단어는 모두 앵커가 된다", len(anchors) == len(WORDS) - 1, f"{len(anchors)}/{len(WORDS)}")

# 품질 지표는 실제로 계산되어야 한다 — 예전에는 전부 1.0 고정이었다.
good = daemon.measure([[0, 100, 400, 0.9], [1, 400, 900, 0.9]], [[100, 900]], 0.95, 200_000, True)
bad = daemon.measure([[0, 900, 1000, 0.4], [1, 100, 200, 0.4]], [[900, 1000], [100, 150]], 0.2, 200_000, False)
check("정상 정렬은 순서 지표가 1.0", good["monotonicity"] == 1.0)
check("역행하는 정렬은 순서 지표가 낮다", bad["monotonicity"] < 1.0, str(bad["monotonicity"]))
check("찰나로 끝나는 줄은 감점된다", bad["line_plausibility"] < good["line_plausibility"])
check("ASR 앵커 여부가 기록된다", good["asr_anchored"] == 1.0 and bad["asr_anchored"] == 0.0)
check("지표가 전부 1.0으로 고정되지 않는다", len({round(value, 3) for value in bad.values()}) > 1, str(bad))

print()
if failures:
    print(f"실패 {len(failures)}건: {', '.join(failures)}")
    sys.exit(1)
print("전부 통과")
