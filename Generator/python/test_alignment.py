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


# 아래쪽 테스트들이 heard 라는 이름을 값으로 쓰기도 해서, 뒤에서도 부를 수 있는 별칭을 둔다.
spoken_words = heard


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


# ── 음절 수 세기: 시간을 나눌 몫이므로 정확할 필요는 없고 공평하면 된다 ──
check("한글은 글자마다 한 음절", daemon.syllables("도망쳐") == 3)
check("한 글자 낱말은 한 몫", daemon.syllables("날") == 1)
check("괄호는 세지 않는다", daemon.syllables("(보다)") == 2)
check("라틴 문자는 모음 덩어리로 센다", daemon.syllables("we") == 1 and daemon.syllables("hachiware") == 4)
check("숫자도 한 몫", daemon.syllables("3") == 1)
check("셀 것이 없어도 한 몫은 준다", daemon.syllables("!!") == 1)

check("토큰이 낱말이면 음절대로", daemon.token_weights(["못 도망쳐"], [2]) == [1.0, 3.0])
check("토큰이 낱말이 아니면 같은 몫", daemon.token_weights(["못 도망쳐"], [5]) == [1.0] * 5)


# ── 줄 안의 경계는 들은 자리에서 다시 긋는다: 실측한 "…씨발 내 목 좀 놔줄래" ──
# 정렬기는 네 낱말을 630ms 에 눌러 담고 놔줄래에 774ms 를 줬다. 바닥만 지켜서는
# 목·좀이 121ms 에 붙어 있을 뿐이고, 놔줄래가 틀렸다는 건 줄 안에서 알 길이 없다.
check("사상은 조절점 밖에서 평평하다", daemon.warp([(100.0, 200.0), (300.0, 500.0)], 50.0) == 200.0)
check("사상은 조절점 사이에서 곧다", daemon.warp([(100.0, 200.0), (300.0, 500.0)], 200.0) == 350.0)
check("사상은 조절점에서 정확하다", daemon.warp([(100.0, 200.0), (300.0, 500.0)], 300.0) == 500.0)

WITNESS_LINE = "내 옆에 서 있어야해 씨발 내 목 좀 놔줄래"
witness_words: list[list[int | float]] = [
    [0, 78920, 79264, 0.63], [1, 79264, 79908, 0.83], [2, 79908, 80119, 0.68], [3, 80119, 80592, 0.73],
    [4, 80592, 80907, 0.85], [5, 80907, 81064, 0.50], [6, 81064, 81185, 0.75], [7, 81185, 81306, 0.47],
    [8, 81306, 82020, 0.62],
]
# 받아쓰기가 들은 자리. 내·옆에는 정렬기가 준 줄 앞이라 쓰이지 않는다.
witness_heard = {0: 78600.0, 1: 78680.0, 2: 79660.0, 3: 79660.0, 4: 80700.0, 6: 81060.0, 7: 81280.0, 8: 81460.0}
daemon.snap_words_to_witness(witness_words, [9], dict(witness_heard))
spans = {int(w[0]): (w[2] - w[1]) for w in witness_words}
check("눌린 낱말이 들은 만큼 길어진다", spans[6] >= 200 and spans[7] >= 170, f"목 {spans[6]}ms 좀 {spans[7]}ms")
check("자리를 쥐고 있던 낱말이 내놓는다", spans[8] <= 600, f"놔줄래 {spans[8]}ms")
check("줄의 시작과 끝은 못 박힌다", witness_words[0][1] == 78920 and witness_words[-1][2] == 82020, str([witness_words[0][1], witness_words[-1][2]]))
check("순서가 뒤집히지 않는다", all(witness_words[i][2] <= witness_words[i + 1][1] for i in range(len(witness_words) - 1)))
check("들은 자리에 정확히 온다", witness_words[6][1] == 81060 and witness_words[7][1] == 81280, str([witness_words[6][1], witness_words[7][1]]))

# 증언 대부분이 줄 밖을 가리키면 어긋난 것은 줄이다 — 그런 줄은 건드리지 않는다.
drifted: list[list[int | float]] = [[0, 110660, 111150, 0.9], [1, 111150, 111310, 0.9], [2, 111310, 111480, 0.9], [3, 111480, 112870, 0.9]]
before = [row[:] for row in drifted]
daemon.snap_words_to_witness(drifted, [4], {0: 109540.0, 1: 109800.0, 2: 110060.0, 3: 112120.0})
check("줄 전체가 밀린 경우에는 손대지 않는다", drifted == before, str(drifted))

# 말하는 인트로에서 들린 소리는 그 줄의 증인이 아니다.
intro: list[list[int | float]] = [[0, 24260, 25000, 0.9], [1, 25000, 27500, 0.9]]
untouched = [row[:] for row in intro]
daemon.snap_words_to_witness(intro, [2], {0: 4940.0, 1: 5200.0})
check("줄 밖의 증언은 무시한다", intro == untouched, str(intro))


# ── 짓눌린 낱말: 실측한 "출근하는 아빠옆에 못 남아 난 도망쳐" ──
# 앞 낱말이 1429ms 를 쥐고, 뒤의 일곱 음절이 300ms 를 나눠 가졌다. 초당 스무 음절은
# 노래가 아니다 — 가장 빠른 랩이 열 음절이다.
CRUSHED_LINE = "출근하는 아빠옆에 못 남아 난 도망쳐"
crushed = [
    [0, 57320, 57843, 0.62],
    [1, 58510, 59939, 0.81],
    [2, 60043, 60104, 0.66],   # 못
    [3, 60124, 60164, 0.00],   # 남아
    [4, 60224, 60264, 0.48],   # 난
    [5, 60284, 60344, 0.00],   # 도망쳐
]
crushed_lines = [[57320, 60344]]
weights = daemon.token_weights([CRUSHED_LINE], [6])
daemon.spread_crushed_words(crushed, crushed_lines, [6], weights)
check("몫은 음절 수를 따른다", weights == [4.0, 4.0, 1.0, 2.0, 1.0, 3.0], str(weights))
check("짓눌린 낱말이 모두 바닥을 넘는다", all(w[2] - w[1] >= 100 for w in crushed[2:]), str([w[2] - w[1] for w in crushed[2:]]))
check("긴 낱말이 더 긴 시간을 갖는다", (crushed[5][2] - crushed[5][1]) > (crushed[4][2] - crushed[4][1]), f"도망쳐 {crushed[5][2]-crushed[5][1]}ms vs 난 {crushed[4][2]-crushed[4][1]}ms")
check("삼킨 앞 낱말이 시간을 내놓는다", (crushed[1][2] - crushed[1][1]) < 1429, f"{crushed[1][2] - crushed[1][1]}ms")
check("줄 길이는 그대로다", crushed_lines[0] == [57320, 60344], str(crushed_lines[0]))
check("순서가 뒤집히지 않는다", all(crushed[i][2] <= crushed[i + 1][1] for i in range(len(crushed) - 1)), str(crushed))
check("시간을 새로 만들지 않는다", crushed[0][1] == 57320 and crushed[-1][2] == 60344)
# 받아쓰기는 못 59.08, 남아 59.32, 도망쳐 59.88 이라 했다 — 독립된 증인과 0.3초 안에서 만난다.
check("독립된 증인과 만난다", abs(crushed[3][1] - 59320) < 400, f"남아 {crushed[3][1]}ms")

single = [[0, 13344, 14058, 0.9], [1, 14058, 14863, 0.9], [2, 14863, 15528, 0.9], [3, 15528, 15568, 0.9], [4, 15568, 15900, 0.9]]
single_lines = [[13344, 15900]]
daemon.spread_crushed_words(single, single_lines, [5], daemon.token_weights(["사막같은 몸에서 겨우 날 떼어"], [5]))
check("날이 볼 수 있는 길이를 갖는다", single[3][2] - single[3][1] >= 120, f"{single[3][2] - single[3][1]}ms")
check("시간은 앞 단어에서 나온다", single[2][2] == single[3][1], f"겨우 끝 {single[2][2]} vs 날 시작 {single[3][1]}")
check("멀쩡한 이웃은 건드리지 않는다", single[0] == [0, 13344, 14058, 0.9], str(single[0]))

tight = [[0, 1000, 1120, 0.9], [1, 1120, 1160, 0.9], [2, 1160, 1280, 0.9]]
daemon.spread_crushed_words(tight, [[1000, 1280]], [3], [1.0, 1.0, 1.0])
check("자리가 없으면 있는 만큼 고르게 나눈다", all(abs((w[2] - w[1]) - 93) <= 2 for w in tight), str([w[2] - w[1] for w in tight]))
check("자리가 없어도 줄 밖으로 나가지 않는다", tight[0][1] == 1000 and tight[2][2] == 1280, str(tight))

fine = [[0, 0, 500, 0.9], [1, 500, 900, 0.9]]
daemon.spread_crushed_words(fine, [[0, 900]], [2], [2.0, 2.0])
check("충분한 단어는 그대로 둔다", fine == [[0, 0, 500, 0.9], [1, 500, 900, 0.9]], str(fine))


# ── 띄어쓰기: 가사와 받아쓰기가 늘 다르게 끊는다 ──
# uruma "하치와레girl" 은 앵커가 모자라 비례추정으로 떨어졌고, 그 시작이 말하는 인트로였다.
KO_LINES = ["어딘지도 모르는 차가운 이 도시속에", "너 하나 보기 위해 달린거야 맨발로 매일"]
KO_WORDS = [daemon.comparable(w) for line in KO_LINES for w in line.split()]
KO_HEARD = spoken_words([
    ("어딘지도", 7.0, 7.6), ("모르는", 7.7, 8.3), ("차가운", 8.4, 9.0), ("이", 9.1, 9.3),
    ("도시", 9.4, 9.8), ("속에", 9.9, 10.4),          # 가사는 "도시속에" 한 단어
    ("너하나", 11.0, 11.7),                            # 가사는 "너 하나" 두 단어
    ("보기위해", 11.8, 12.6), ("달린거야", 12.7, 13.5), ("맨발로", 13.6, 14.2), ("매일", 14.3, 15.0),
])
ko_anchors = daemon.match_sequences(KO_WORDS, KO_HEARD)
check("붙여 쓴 가사도 띄어 쓴 받아쓰기와 맞는다", 0 in ko_anchors and 4 in ko_anchors, f"앵커 {sorted(ko_anchors)}")
check("띄어쓰기 차이로 대부분을 잃지 않는다", len(ko_anchors) >= len(KO_WORDS) - 1, f"{len(ko_anchors)}/{len(KO_WORDS)}")

# 말하는 인트로 위에 첫 줄이 놓이지 않는다.
SPOKEN = spoken_words([("자", 1.4, 1.8), ("이제", 1.9, 2.4), ("시작해볼까", 2.5, 3.4), ("들어봐", 3.6, 4.4)])
ko_counts = [len(line.split()) for line in KO_LINES]
ko_windows = daemon.anchored_windows(ko_counts, KO_WORDS, SPOKEN + KO_HEARD, 1.4, 15.0)
check("앵커가 만들어진다", ko_windows is not None)
assert ko_windows is not None
check("첫 줄이 노래가 시작하는 곳에서 열린다", abs(ko_windows[0][0] / 1000 - 7.0) < 0.3, f"{ko_windows[0][0] / 1000:.1f}s")
proportional_ko, _ = daemon.proportional_spans(ko_counts, 1.4, 15.0)
check("비례추정은 말하는 인트로에서 시작했다 (회귀 대비)", proportional_ko[0][0] / 1000 < 2.0, f"{proportional_ko[0][0] / 1000:.1f}s")

# 한 글자가 우연히 겹친 것을 앵커로 삼지 않는다.
stray = daemon.match_sequences(["사랑해"], spoken_words([("사", 1.0, 1.1)]))
check("한 글자 겹침은 앵커가 아니다", stray == {}, str(stray))


# 앵커가 아예 안 잡혀도, 가사에 없는 말하는 인트로에서 시작하지는 않는다.
asr_with_intro = {"segments": [
    {"start": 1.4, "end": 4.4, "words": [
        {"word": "자", "start": 1.4, "end": 1.8}, {"word": "이제", "start": 1.9, "end": 2.4},
        {"word": "시작해볼까", "start": 2.5, "end": 3.4}, {"word": "들어봐", "start": 3.6, "end": 4.4}]},
    {"start": 7.0, "end": 15.0, "words": [
        {"word": "어딘지도", "start": 7.0, "end": 7.6}, {"word": "모르는", "start": 7.7, "end": 8.3}]},
]}
bounded = daemon.audio_bounds(asr_with_intro, 15_000, KO_WORDS)
check("가사 없는 인트로를 건너뛰고 시작한다", abs(bounded[0] - 7.0) < 0.05, f"{bounded[0]}s")
check("비교할 가사가 없으면 첫 소리에서 시작한다", abs(daemon.audio_bounds(asr_with_intro, 15_000)[0] - 1.4) < 0.05)
check("끝은 그대로다", abs(bounded[1] - 15.0) < 0.05, f"{bounded[1]}s")


# ── 첫 앵커보다 앞선 줄: 인트로로 밀려나서도, 한 점에 뭉개져서도 안 된다 ──
# 실측한 "하치와레girl": 0~10초가 말하는 인트로이고 가사와 맞는 첫 단어는 30.6초에 나온다.
INTRO_LINES = ["어딘지도 모르는 차가운 이 도시속에", "너 하나 보기 위해 달린거야 맨발로 매일", "가방에 달고다녀 카와이 하치와레", "만난 적 없는 널 만나"]
INTRO_COUNTS = [len(line.split()) for line in INTRO_LINES]
INTRO_WORDS = [daemon.comparable(w) for line in INTRO_LINES for w in line.split()]
INTRO_HEARD = spoken_words([
    ("오하요", 0.0, 1.0), ("실은요", 4.7, 5.4), ("공부했었다", 5.6, 6.3),   # 가사에 없는 말
    ("으음", 10.6, 12.0), ("놀랐어", 12.0, 13.2), ("알았다", 23.4, 29.9),   # 가사와 맞지 않는 소리
    # 여기서부터 가사와 맞는다
    ("가방에", 30.6, 31.2), ("달고", 31.3, 31.7), ("다녀", 31.8, 32.1), ("카와이", 32.2, 32.8),
    ("하치와레", 32.9, 33.6), ("만난", 34.0, 34.4), ("적", 34.5, 34.7), ("없는", 34.8, 35.2),
    ("널", 35.3, 35.5), ("만나", 35.6, 36.1),
])
intro_start, intro_end = daemon.audio_bounds({"segments": [{"start": 0.0, "end": 33.0, "words": [
    {"word": w["text"], "start": w["start"], "end": w["end"]} for w in INTRO_HEARD]}]}, 40_000, INTRO_WORDS)
check("가사가 처음 들리는 곳에서 시작한다", abs(intro_start - 30.6) < 0.05, f"{intro_start}s")
intro_windows = daemon.anchored_windows(INTRO_COUNTS, INTRO_WORDS, INTRO_HEARD, intro_start, intro_end, floor=0.0)
check("앵커가 만들어진다", intro_windows is not None)
assert intro_windows is not None
check("말하는 인트로에는 아무 줄도 놓이지 않는다", intro_windows[0][0] > 10_000, f"{intro_windows[0][0] / 1000:.1f}s")
check("첫 앵커 앞 줄들이 한 점에 뭉개지지 않는다", intro_windows[0][1] - intro_windows[0][0] > 500, str(intro_windows[0]))
check("창이 거꾸로 되지 않는다", all(w[1] >= w[0] for w in intro_windows), str(intro_windows))
check("앵커가 있는 줄은 들은 자리에 온다", abs(intro_windows[2][0] / 1000 - 30.6) < 0.2, f"{intro_windows[2][0] / 1000:.1f}s")


# ── 어느 언어로 들을 것인가: 일본어 인트로가 한국어 곡의 언어를 정하면 안 된다 ──
# 실측: language=und 로 자동 감지에 맡겼더니 첫 부분의 일본어 스킷으로 ja 를 골랐고,
# 한국어 노래 전체를 일본어로 받아써 じゃ 를 오백 번 내놓았다. 가사는 언어를 알고 있다.
check("녹음에 언어가 있으면 그것을 따른다",
      daemon.expected_language({"recording": {"language": "ja"}, "lyrics": [{"language": "ko"}]}) == "ja")
check("녹음이 모르면 가사가 말한다",
      daemon.expected_language({"recording": {"language": "und"}, "lyrics": [{"language": "ko"}, {"language": "ko"}]}) == "ko")
check("가사가 갈리면 다수를 따른다",
      daemon.expected_language({"recording": {"language": "und"}, "lyrics": [{"language": "ko"}, {"language": "ko"}, {"language": "en"}]}) == "ko")
check("아무도 모르면 자동 감지에 맡긴다",
      daemon.expected_language({"recording": {"language": "und"}, "lyrics": []}) == "und")
check("지역 꼬리표는 접는다",
      daemon.expected_language({"recording": {"language": "ko-KR"}, "lyrics": []}) == "ko")


# ── 괄호로만 된 줄은 백보컬이다: 옆줄 위에 겹쳐 부르지, 뒤이어 부르지 않는다 ──
# 실측한 "하치와레girl": 네 단어짜리 (나 너 싫으니까 꺼지라고) 가 1.9초를 쥐고, 그 앞의
# 여덟 단어짜리 줄은 0.8초로 짓눌렸다.
check("괄호로만 된 줄을 알아본다", daemon.is_backing_line("(나 너 싫으니까 꺼지라고)"))
check("전각 괄호도 같다", daemon.is_backing_line("（꺼져）"))
check("꼬리에 붙은 괄호는 그 줄의 일부다", not daemon.is_backing_line("사랑해줄래? (꺼져)"))
check("괄호가 중간에 닫히면 감싼 것이 아니다", not daemon.is_backing_line("(가) 그리고 (나)"))
check("괄호 없는 줄은 그대로", not daemon.is_backing_line("어딘지도 모르는"))
check("빈 괄호는 줄로 치지 않는다", not daemon.is_backing_line("()"))

BACKING_DISPLAY = ["넌 뭔데 내 맘에 흉터를 남기는건데", "(나 너 싫으니까 꺼지라고)", "나는 니가 나랑 결혼 안해줄걸 아는데"]
BACKING_LINES = [line.strip("()") for line in BACKING_DISPLAY]
BACKING_COUNTS = [len(line.split()) for line in BACKING_LINES]
BACKING_WORDS = [daemon.comparable(w) for line in BACKING_LINES for w in line.split()]
# 받아쓰기는 메인 보컬만 들었다 — 백보컬 줄의 단어는 하나도 없다.
BACKING_HEARD = spoken_words([
    ("넌", 99.8, 100.1), ("뭔데", 100.2, 100.6), ("내", 100.7, 100.9), ("맘에", 101.0, 101.4),
    ("흉터를", 101.5, 102.0), ("남기는건데", 102.1, 103.0),
    ("나는", 104.0, 104.4), ("니가", 104.5, 104.9), ("나랑", 105.0, 105.4),
    ("결혼", 105.5, 106.0), ("안해줄걸", 106.1, 106.7), ("아는데", 106.8, 107.4),
])
# 창을 나눌 때 빠지는 것은 줄이 아니라 낱말이다 — 괄호가 줄 꼬리에만 붙어 있을 수도 있다.
flags = [flag for line in BACKING_DISPLAY for flag in daemon.bracket_mask(line)]
folded = daemon.anchored_windows(BACKING_COUNTS, BACKING_WORDS, BACKING_HEARD, 99.8, 108.0, 0.0, backing=flags)
check("백보컬을 접어도 창이 만들어진다", folded is not None)
assert folded is not None
check("백보컬은 옆줄과 같은 시간을 쓴다", folded[1] == folded[2], f"{folded[1]} vs {folded[2]}")
check("앞 줄이 자기 시간을 지킨다", (folded[0][1] - folded[0][0]) >= 3000, f"{(folded[0][1] - folded[0][0]) / 1000:.1f}초")
check("뒷 줄이 자기 시간을 지킨다", (folded[2][1] - folded[2][0]) >= 3000, f"{(folded[2][1] - folded[2][0]) / 1000:.1f}초")
check("창이 거꾸로 되지 않는다", all(w[1] >= w[0] for w in folded), str(folded))

# 괄호가 줄 꼬리에만 붙은 경우 — 실측한 "그래도 제발 나를 사랑해줄래? (꺼져)".
# (꺼져) 를 낱말로 세면 그 몫만큼 줄이 늘어나, 메인 보컬이 이미 끝난 자리까지 창이 걸친다.
INLINE_DISPLAY = ["그래도 제발 나를 사랑해줄래? (꺼져)", "넌 뭔데 내 맘에 흉터를"]
INLINE_COUNTS = [len(line.split()) for line in INLINE_DISPLAY]
INLINE_WORDS = [daemon.comparable(word) for line in INLINE_DISPLAY for word in line.split()]
INLINE_HEARD = spoken_words([
    ("그래도", 97.32, 97.86), ("제발", 97.86, 98.56), ("나를", 98.56, 98.98), ("사랑해줄래", 98.98, 99.94),
    ("넌", 100.20, 100.60), ("뭔데", 100.60, 101.00), ("내", 101.00, 101.34), ("맘에", 101.34, 101.80), ("흉터를", 101.80, 102.36),
])
inline_flags = [flag for line in INLINE_DISPLAY for flag in daemon.bracket_mask(line)]
check("꼬리 괄호는 그 낱말만 백보컬이다", inline_flags == [False, False, False, False, True, False, False, False, False, False], str(inline_flags))
inline = daemon.anchored_windows(INLINE_COUNTS, INLINE_WORDS, INLINE_HEARD, 97.32, 102.36, 0.0, backing=inline_flags)
counted = daemon.anchored_windows(INLINE_COUNTS, INLINE_WORDS, INLINE_HEARD, 97.32, 102.36, 0.0)
check("꼬리 괄호가 있어도 창이 만들어진다", inline is not None and counted is not None)
assert inline is not None and counted is not None
check("창은 메인 보컬이 끝난 데서 끝난다", inline[0][1] == 99_940, f"{inline[0][1]}ms (들은 끝 99940ms)")
check("낱말로 세면 그 뒤까지 늘어난다 (회귀 대비)", counted[0][1] > inline[0][1], f"세면 {counted[0][1]}ms")
check("다음 줄은 제자리에 있다", inline[1][0] == counted[1][0] == 100_200, f"{inline[1][0]} vs {counted[1][0]}")

# 백보컬이 마지막 줄이면 앞줄과 함께 간다.
tail_display = ["넌 뭔데 내 맘에 흉터를 남기는건데", "나는 니가 나랑 결혼 안해줄걸 아는데", "(꺼지라고)"]
tail_flags = [flag for line in tail_display for flag in daemon.bracket_mask(line)]
tail_lines = [line.strip("()") for line in tail_display]
tail_counts = [len(line.split()) for line in tail_lines]
tail_words = [daemon.comparable(w) for line in tail_lines for w in line.split()]
tail = daemon.anchored_windows(tail_counts, tail_words, BACKING_HEARD, 99.8, 108.0, 0.0, backing=tail_flags)
check("마지막 백보컬은 앞줄과 함께", tail is not None and tail[2] == tail[1], str(tail))


# ── 정렬기는 한 구간에 한 답을 주지 않는다: 문장 부호에서 다시 자른다 ──
# 실측한 "하치와레girl": 물음표가 든 줄이 둘 있었고, 32줄을 넘겨 34구간을 돌려받았다.
# 줄 번호로 답을 읽으면 그 뒤로 모든 줄이 앞줄의 소리를 갖는다 — 노래 마지막 3분의 1이
# 두 줄씩 이르게 놓였다. 그래서 한 줄씩 묻는다.
class ReCuttingAligner:
    """물음표에서 구간을 쪼개는, 실제로 관찰된 정렬기의 행동."""

    def align(self, segments, model, metadata, audio, device, return_char_alignments=False):
        out = []
        for segment in segments:
            span = float(segment["end"]) - float(segment["start"])
            pieces = [piece.strip() for piece in segment["text"].replace("?", "?\n").split("\n") if piece.strip()]
            for index, piece in enumerate(pieces):
                at = float(segment["start"]) + span * index / max(1, len(pieces))
                out.append({"text": piece, "words": [{"word": word, "start": at, "end": at + 0.2} for word in piece.split()]})
        return {"segments": out}


ASKING_LINES = ["그래도 제발 나를 사랑해줄래? (꺼져)", "넌 뭔데 내 맘에 흉터를 남기는건데? (나 너 싫으니까 꺼지라고)", "나는 니가 나랑 결혼 안해줄걸 아는데"]
ASKING_WINDOWS = [(97.3, 100.5), (100.5, 103.5), (103.5, 106.0)]
recut = ReCuttingAligner()
per_line = [
    daemon.align_line(line, start, end, recut, None, None, None, "cpu")
    for line, (start, end) in zip(ASKING_LINES, ASKING_WINDOWS)
]
check("한 줄씩 물으면 줄 수만큼 답이 온다", len(per_line) == len(ASKING_LINES), str(len(per_line)))
check("쪼개진 조각도 제 줄에 모인다", [len(words) for words in per_line] == [5, 10, 6], str([len(w) for w in per_line]))
check("괄호 뒤 줄이 앞줄의 소리를 갖지 않는다", per_line[2][0]["start"] >= 103.5, f"{per_line[2][0]['start']}s")
check("마지막 줄이 창 안에 있다", per_line[2][-1]["end"] <= 106.0 + 0.3, f"{per_line[2][-1]['end']}s")
# 줄 번호로 읽던 옛 방식이 실제로 어긋났음을 같은 정렬기로 보인다.
flat = recut.align(
    [{"start": start, "end": end, "text": line} for line, (start, end) in zip(ASKING_LINES, ASKING_WINDOWS)], None, None, None, "cpu"
)["segments"]
check("한꺼번에 물으면 줄 수보다 답이 많다", len(flat) > len(ASKING_LINES), f"{len(flat)}구간 vs {len(ASKING_LINES)}줄")
check("그때 마지막 줄은 앞줄의 소리를 받는다", flat[2]["words"][0]["start"] < 103.5, f"{flat[2]['words'][0]['start']}s")

print()
if failures:
    print(f"실패 {len(failures)}건: {', '.join(failures)}")
    sys.exit(1)
print("전부 통과")

