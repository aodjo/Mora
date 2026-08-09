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

# ── 장음 끝점: "Fun~~~~"은 Fun이 발음된 순간이 아니라 끝까지 끈 데서 끝나야 한다 ──
def _held_case() -> tuple[list[list[int | float]], list[list[int]], dict[int, int], list[dict[str, object]]]:
    # 2행: [사랑해(0), Fun~~~~(1)] / [다음(2), 줄(3)]. 정렬기는 Fun을 12.0~12.4로 봤지만
    # ASR은 같은 자리에서 12.0~15.8짜리 소리를 들었다. 다음 줄은 17.0에 시작한다.
    words: list[list[int | float]] = [[0, 10.0e3, 11.5e3, 0.9], [1, 12.0e3, 12.4e3, 0.9], [2, 17.0e3, 17.5e3, 0.9], [3, 17.6e3, 18.2e3, 0.9]]
    lines = [[10000, 12400], [17000, 18200]]
    last = {1: 0, 3: 1}
    heard = [
        {"text": "사랑해", "start": 10.0, "end": 11.5},
        {"text": "fun", "start": 12.0, "end": 15.8},
        {"text": "다음", "start": 17.0, "end": 17.5},
        {"text": "줄", "start": 17.6, "end": 18.2},
    ]
    return words, lines, last, heard

words, lines, last, heard = _held_case()
daemon.extend_held_endings(words, lines, last, heard)
check("장음은 ASR이 들은 끝까지 늘어난다", words[1][2] == 15800, f"{words[1][2]}")
check("줄 스팬도 함께 늘어난다", lines[0][1] == 15800, f"{lines[0][1]}")
check("다음 줄과 겹치지 않는다", words[1][2] < words[2][1], f"{words[1][2]} vs {words[2][1]}")
check("마지막 줄의 끝 단어도 처리된다", words[3][2] == 18200, f"{words[3][2]}")

# 짧게 끝난 단어는 그대로 둔다 — ASR도 짧게 들었다.
words2, lines2, last2, _ = _held_case()
short = [{"text": "fun", "start": 12.0, "end": 12.4}]
daemon.extend_held_endings(words2, lines2, last2, short)
check("길게 들리지 않았으면 늘리지 않는다", words2[1][2] == 12400, f"{words2[1][2]}")

# 다음 줄이 바짝 붙어 있으면 그 직전까지만.
words3, lines3, last3, heard3 = _held_case()
words3[2][1] = 13.0e3
daemon.extend_held_endings(words3, lines3, last3, heard3)
check("늘려도 다음 줄 시작 직전에서 멈춘다", words3[1][2] == 12960, f"{words3[1][2]}")


# ── 줄 시작의 소음: 정렬기가 앞 소음을 첫 단어로 삼키면 ASR이 들은 시작이 이긴다 ──
# 실측: "이상한 소음 다음에 단어" — 하이라이트가 소음에서 켜졌다.
words4: list[list[int | float]] = [[0, 9.0e3, 11.0e3, 0.5], [1, 11.2e3, 11.9e3, 0.9]]
lines4 = [[9000, 11900]]
daemon.snap_line_starts(words4, lines4, [2], {0: 10.55e3})  # ASR은 10.55초에 첫 단어를 들었다
check("소음을 삼킨 첫 단어는 들은 시작으로 당겨진다", words4[0][1] == 10470, f"{words4[0][1]}")
check("줄 스팬 시작도 함께 온다", lines4[0][0] == 10470, f"{lines4[0][0]}")
check("줄 안 두 번째 단어는 건드리지 않는다", words4[1][1] == 11200, f"{words4[1][1]}")

# 250ms 이내 차이는 정렬기의 미세한 판정이 우선이다.
words5: list[list[int | float]] = [[0, 10.4e3, 11.0e3, 0.9]]
lines5 = [[10400, 11000]]
daemon.snap_line_starts(words5, lines5, [1], {0: 10.55e3})
check("작은 차이는 그대로 둔다", words5[0][1] == 10400, f"{words5[0][1]}")

# 당기더라도 단어 몸통은 남긴다.
words6: list[list[int | float]] = [[0, 9.0e3, 10.6e3, 0.5]]
lines6 = [[9000, 10600]]
daemon.snap_line_starts(words6, lines6, [1], {0: 10.65e3})
check("끝 직전까지만 당긴다", words6[0][1] == 10480, f"{words6[0][1]}")

# ASR이 첫 단어를 못 들었으면(앵커 없음) 손대지 않는다.
words7: list[list[int | float]] = [[0, 9.0e3, 11.0e3, 0.5]]
lines7 = [[9000, 11000]]
daemon.snap_line_starts(words7, lines7, [1], {})
check("증인이 없으면 그대로 둔다", words7[0][1] == 9000, f"{words7[0][1]}")


# ── 정렬기가 못 맞춘 짧은 단어: "we", "다" 같은 것들 ──
# 버리면 남은 단어들의 매핑이 통째로 밀린다 — "we gonna"가 "gonna"의 두 조각이 됐다.
line = [
    {"word": "we"},                                   # 정렬기가 자리를 못 잡은 단어
    {"word": "gonna", "start": 12.4, "end": 12.9, "score": 0.9},
    {"word": "ride", "start": 13.0, "end": 13.6, "score": 0.9},
]
filled = daemon.fill_unaligned(line, 12.0, 14.0)
check("못 맞춘 단어도 줄에 남는다", len(filled) == 3, f"{len(filled)}개")
check("앞 단어는 다음 단어보다 먼저 온다", filled[0]["end"] <= filled[1]["start"] + 1e-6, f"{filled[0]}")
check("앞 단어가 gonna 자리를 뺏지 않는다", filled[0]["end"] <= 12.4 + 1e-6, f"{filled[0]['end']}")
check("맞춘 단어의 시간은 그대로다", filled[1]["start"] == 12.4 and filled[1]["end"] == 12.9)
check("자리만 잡아준 단어는 낮은 점수를 갖는다", filled[0]["score"] == 0.3, str(filled[0].get("score")))

# 줄 끝에서 못 맞춘 경우 — 창의 끝까지를 나눠 갖는다.
tail = [{"word": "사랑", "start": 20.0, "end": 20.6, "score": 0.9}, {"word": "다"}]
filled_tail = daemon.fill_unaligned(tail, 19.8, 21.0)
check("끝에서 빠진 단어도 자리를 얻는다", len(filled_tail) == 2 and filled_tail[1]["start"] >= 20.6, str(filled_tail[1]))
check("끝 단어가 창 밖으로 나가지 않는다", filled_tail[1]["end"] <= 21.0 + 1e-6, str(filled_tail[1]["end"]))

# 연달아 빠지면 사이를 고르게 나눈다.
run = [{"word": "a"}, {"word": "b"}, {"word": "c", "start": 5.0, "end": 5.4, "score": 0.9}]
filled_run = daemon.fill_unaligned(run, 4.0, 6.0)
check("연달아 빠진 단어는 사이를 고르게 나눈다", len(filled_run) == 3 and abs((filled_run[0]["end"] - filled_run[0]["start"]) - (filled_run[1]["end"] - filled_run[1]["start"])) < 1e-6)
check("순서는 지켜진다", filled_run[0]["start"] <= filled_run[1]["start"] <= filled_run[2]["start"])

# 아무것도 못 맞춘 줄은 자리를 지어내지 않는다.
check("전부 못 맞춘 줄은 비운다", daemon.fill_unaligned([{"word": "a"}, {"word": "b"}], 1.0, 2.0) == [])
check("빈 줄은 빈 채로", daemon.fill_unaligned([], 1.0, 2.0) == [])

# 밀림이 실제로 사라지는지 — 세 단어짜리 줄을 세 토큰에 투영한다.
projected = daemon.interpolate_boundaries(filled, 3)
check("we 가 gonna 자리로 밀려나지 않는다", projected[0][2] <= 12_500, f"we 끝 {projected[0][2]}ms")
check("gonna 는 자기 자리를 지킨다", 12_300 <= projected[1][1] <= 12_700, f"gonna 시작 {projected[1][1]}ms")

print()
if failures:
    print(f"실패 {len(failures)}건: {', '.join(failures)}")
    sys.exit(1)
print("전부 통과")

