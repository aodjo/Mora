#!/usr/bin/env python3
"""
가사를 아는 채로 소리에 맞춘다 — 강제 정렬.

사람이 낱말 백 개를 맨바닥에서 놓을 수는 없다. 지금은 글자 수만큼 나눠 깔아 두는데 그것은
「그럴듯한 자리」일 뿐 소리를 듣고 정한 자리가 아니다. 모델을 한 번 돌려 어느 정도 맞춰 놓고
사람이 틀린 것만 고치는 편이 낫다.

받아쓰기는 필요 없다. 무슨 말인지는 이미 아니까 **아는 글자를 소리에 맞추기만** 하면 된다.
갤북에는 NVIDIA 가 없지만 Intel Arc 가 붙어 있어 `torch.xpu` 로 돌린다 — CPU 로도 되지만
나중에 더 큰 것을 돌릴 자리이기도 하다.

**곡 전체를 한 번에** 맞춘다. 처음엔 줄마다 그 구간만 잘라 맞췄는데, 줄 시각은 **시작**만
찍힌 값이라 창의 끝을 어디로 잡아도 틀렸다. 창이 노래보다 먼저 끝나면 남은 글자가 마지막
몇 프레임에 욱여넣어져 0.02 초씩 붙는다 — 「남겨질테니까」의 `테·니·까` 가 29.60·29.62·
29.64 로 나왔다. 창을 넓히는 것은 그 자리를 옮길 뿐이다.

CTC 맞추기는 주어진 토큰 차례에 대해 **전체가 가장 그럴듯한 길**을 찾는다. 한 군데가
애매해도 뒤로 밀고 가지 않으므로, 담을 없애는 편이 담을 잘 세우는 것보다 낫다.

주의 — 여기서 나온 것은 **정답이 아니라 출발점**이다. 이대로 두고 「맞음」을 누르면 우리
모델의 실수가 그대로 정답이 되어, 그 정답으로 우리 모델을 재게 된다. 사람이 실제로 고쳐야
한다.
"""
from __future__ import annotations

import re
import subprocess
import unicodedata
from pathlib import Path

# 강제 정렬 전용 다국어 모델(torchaudio 의 MMS_FA).
#
# 처음엔 한국어 ASR 모델(`kresnik/wav2vec2-large-xlsr-korean`)을 썼다. 어휘가 한글이라
# 로마자로 옮기는 단계가 없어 편했지만, 읽는 말로 훈련된 것이라 노래에서 자주 길을 잃었다.
# 세 곡을 같은 자로 견주니 차이가 뚜렷하다 — 특히 되풀이가 많은 랩 곡에서:
#
#   곡                   한국어 모델              MMS_FA
#   사랑하게 될거야       78ms · 0.3초 초과 6 줄    65ms · 5 줄
#   미안하다는말          15ms · 1 줄              32ms · 0 줄
#   Trip                52ms · **21 줄**         29ms · **1 줄**
#
# MMS_FA 는 애초에 **맞추기 위해** 만들어진 것이고 천 개 넘는 말을 함께 배웠다. 어휘가
# 로마자 스물아홉 자뿐이라 한글을 옮겨 넣어야 하는데(uroman), 덕분에 「어휘에 없는 글자」가
# 아예 사라진다 — 「괜」 처럼 어휘 밖이라 통째로 못 붙던 자리가 없어졌다.
SAMPLE_RATE = 16_000
# 낱말 하나가 가질 수 있는 가장 짧은 길이. 화면에서 잡으려면 이만큼은 있어야 한다.
LEAST_MS = 60
# 한 글자를 아무리 끌어도 이보다 길게는 안 본다. 발라드에서 끝음을 1~2 초 끄는 것은
# 흔하지만, 그 뒤 간주까지 이어 붙이면 화면에서 한 글자가 몇 초씩 차오른다.
HOLD_MS = 1500
# 꼬리를 자를 때의 문턱(nat). 그 프레임에서 가장 그럴듯한 글자보다 이만큼 못 미치면
# 「붙여 놓았을 뿐 실제로 그 글자를 들은 것은 아니다」로 본다.
SUPPORT = 2.5
# 그 자리에서 모델이 고른 글자보다 이만큼 못하면 짚어 준다(nat).
#
# 3 으로 두었다가 252 개 중 141 개(56%)가 걸렸다. 그만큼 걸리면 짚어 주는 뜻이 없다.
#
# 애초에 이 값은 **시각이 맞았나**를 재지 않는다. 「모델의 1 순위가 이 글자와 같은가」인데,
# 1207 갈래 분류를 노래에 대고 물으면 절반 넘게 틀리는 것이 당연하고 그것이 시각이 틀렸다는
# 뜻은 아니다 — 실제로 줄 시작을 바이브와 견주면 오차 가운뎃값이 15ms 다.
#
# 그래서 이것은 잣대가 아니라 **눈길을 끄는 표시**로만 쓴다. 크게 어긋난 자리만 짚도록
# 조인다. 잴 것은 아래의 「줄 시작을 밖에서 온 시각과 견주기」 쪽이다.
DOUBT = -8.0
# 소리가 시작한 자리를 찾아 되짚을 때, 최대 몇 프레임까지 갈까(한 프레임 20ms).
# 열두 프레임이면 0.24 초 — 한글 음절 하나가 그보다 길게 시작하지는 않는다.
# CTC 봉우리가 음절의 시작보다 이만큼 늦다(ms). 세 곡에서 +0.18·+0.22·+0.25 로 나왔다.
ONSET_LEAD_MS = 200
# 글자 사이가 이보다 촘촘하면 사람이 낼 수 없는 속도로 본다(ms). 초당 열두 음절이 한계다.
CRAMP_MS = 80
# 밖에서 온 줄 시각과 이만큼 넘게 어긋난 줄은 다시 따져 본다. 곡 전체의 치우침은 뺀 뒤에 잰다.
SUSPECT_MS = 500
# 다시 따져 **옮기기까지 하려면** 토큰당 점수가 이만큼은 나아야 한다.
#
# 임의의 숫자가 아니다. 크게 어긋난 줄들을 두 자리(우리가 고른 자리 / 밖에서 온 자리)에서
# 각각 맞춰 보고 점수를 견줬다:
#
#   우리가 틀린 자리    「그럼에도 불구하고」 +2.07 · 「이젠 안될거같아」 +0.65 · If I cared +0.42
#   밖이 틀린 자리      파란달팽이 47·48번 −2.75 −6.01 · Small girl 60·61·62번 −2.08 −4.26 −5.86
#
# 두 무리가 ±0.5 언저리에서 겹친다. 그래서 **뚜렷한 것만** 옮긴다 — 1.0 이면 「그럼에도
# 불구하고」는 옮기고 애매한 것은 그대로 둔다. 애매한 것을 옮기려다 곡 6·7 을 14 초씩
# 망가뜨리는 것보다, 고칠 수 있는 것만 고치는 편이 낫다.
EVIDENCE = 1.0
# 다시 따질 때 앞뒤로 이만큼 열어 준다. 줄 시각이 조금 틀려도 담기게.
LOOK_MS = 1500
# 같은 글월의 다른 번과 견줘 이 배 넘게 길거나 짧으면 무너진 것으로 본다.
# 재 보니 무너진 줄은 3~4 배였고(0.88초 대 10.23초) 멀쩡한 되풀이는 1.3 배 안쪽이었다.
STRETCH = 1.8
# 한 줄 안에서 글자 사이가 이만큼 비면 그 사이 어딘가에서 길을 잃은 것이다.
# 노래가 한 줄 안에서 2 초를 쉬는 일은 드물다.
STUCK_HOLE_MS = 2000
# 서브 보컬 갈래가 토큰당 이만큼 넘게 나아야 그 줄을 서브로 본다.
#
# 한쪽으로 기울여 둔다. 리드가 곡의 대부분이고, 리드 줄을 잘못 서브로 보내면 거의 비어 있는
# 소리 위에서 맞춰져 크게 틀린다. 반대로 서브 줄을 리드에 두면 지금과 같아질 뿐이다 —
# 나빠지지 않는다. 잃을 것이 적은 쪽으로 문턱을 둔다.
VOICE_EDGE = 0.5
# 서브에서 구제한 줄이 리드가 짚은 자리에서 이만큼 넘게 벗어나면 안 믿는다.
# 몇 줄만 맞추면 되풀이 구절이 곡 어디로든 갈 수 있어서다.
RESCUE_REACH_MS = 4000

# 원본에서 **만들어 낸** 소리들. 원본 옆에 같은 이름으로 두므로 원본을 고를 때 걸러야 한다.
MADE_FROM = (".vocals.wav", ".lead.wav", ".back.wav")


def source_in(folder: Path, video_id: str) -> Path | None:
    """그 곡의 **원본** 음원. 만들어 낸 것은 거른다.

    이 한 줄을 여기저기 베껴 두었다가 **같은 함정을 두 번 밟았다.** 먼저 서버가
    `sorted(glob)[0]` 로 골라 `{id}.back.wav` 를 원본으로 집었고(재생도 정렬도 서브 보컬만
    남은 소리가 됐다), 고친 뒤에도 probe 들은 `.vocals.wav` 만 거르고 있어서 똑같이 틀렸다.
    그 틀린 값으로 「곡 전체가 20 초 밀렸다」고 읽고 멀쩡한 코드를 되돌릴 뻔했다.

    **고르는 자리는 하나여야 한다.** 재는 쪽과 쓰는 쪽이 다른 길로 파일을 고르면, 값이
    갈릴 때 원인을 못 찾는다.
    """
    found = sorted(p for p in folder.glob(f"{video_id}.*")
                   if p.suffix != ".part" and not p.name.endswith(MADE_FROM))
    return found[0] if found else None


_bundle: dict = {}


def device():
    """쓸 수 있는 가장 빠른 것. 갤북에는 Intel Arc 가 붙어 있다(`torch.xpu`).

    CUDA 가 없다고 CPU 로 물러설 일이 아니다 — 내장 그래픽도 CPU 보다 훨씬 낫고,
    나중에 더 큰 것을 돌릴 때도 같은 자리를 쓴다.
    """
    import torch
    if hasattr(torch, "xpu") and torch.xpu.is_available():
        return "xpu"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def load():
    """모델은 한 번만 올린다. 1.2 GB 라 곡마다 올리면 그것이 대부분의 시간이 된다."""
    if not _bundle:
        import torch
        import torchaudio
        import uroman
        torch.set_num_threads(8)
        where = device()
        bundle = torchaudio.pipelines.MMS_FA
        _bundle["where"] = where
        _bundle["table"] = bundle.get_dict()
        _bundle["roman"] = uroman.Uroman()
        _bundle["model"] = bundle.get_model().eval().to(where)
    return _bundle["table"], _bundle["model"]


def grains_of(word: str) -> list[str]:
    """어절을 글자로 가른다. **화면 쪽 `grainsOf` 와 같은 규칙이어야 한다.**

    한글은 한 글자씩, 라틴과 숫자는 이어 붙는 만큼 한 덩이. 두 쪽이 다르게 가르면 몇 번째
    글자인지가 어긋나 어절이 통째로 안 붙는다 — 그 부류의 버그를 이미 겪었다(§2 의 토크나이저
    갈림).
    """
    out: list[str] = []
    latin = ""
    for one in unicodedata.normalize("NFC", word):
        if "가" <= one <= "힣":
            if latin:
                out.append(latin)
                latin = ""
            out.append(one)
        elif one.isascii() and (one.isalnum() or one == "'"):
            latin += one
        elif latin:
            out.append(latin)
            latin = ""
    if latin:
        out.append(latin)
    return out


def letters(grain: str) -> list[int]:
    """글자 하나를 로마자로 옮겨 어휘 번호로 바꾼다.

    MMS_FA 의 어휘는 로마자 스물아홉 자뿐이다. 「괜」 은 `gwaen` 이 되어 다섯 자로 들어간다 —
    한글 음절 하나가 여러 토큰이 되지만, 그 첫 토큰이 곧 그 글자가 시작하는 자리다.

    한국어 ASR 모델을 쓰던 앞판은 어휘에 없는 글자를 버려야 했고(「괜」 이 그랬다) 그 어절이
    통째로 안 붙었다. 옮겨 넣으면 못 넣을 글자가 없다.
    """
    table, _ = load()
    # 노랫말은 같은 글자가 숱하게 되풀이된다. 옮기기는 파이썬으로 도는 것이라 곡마다
    # 수백 번 부르면 그것이 시간의 큰 몫이 된다 — 글자마다 한 번만 옮기고 적어 둔다.
    memo = _bundle.setdefault("said", {})
    if grain not in memo:
        memo[grain] = _bundle["roman"].romanize_string(grain).lower()
    return [table[one] for one in memo[grain] if one in table]


def speakable(text: str) -> str:
    """소리로 낼 수 있는 것만 남긴다. 괄호 안 설명과 문장부호는 맞출 대상이 아니다."""
    text = re.sub(r"[\(（\[].*?[\)）\]]", " ", text)
    return re.sub(r"[^0-9A-Za-z가-힣\s]", " ", text)


def fill_gaps(chars: list[dict]) -> None:
    """어휘 밖 글자에 자리를 준다. 제자리에서 고친다.

    모델이 모르는 글자라도 화면에는 있어야 하고 노래에서도 그 자리에서 불린다.

    앞판은 앞머리와 꼬리의 빈 글자를 **모두 같은 시각에 쌓았다** — `chars[i]["at"] = 첫 아는
    글자의 at`. 그래서 「홀업」처럼 어휘 밖 글자로 시작하는 말이 통째로 한 순간에 몰리고,
    앞뒤 글자의 시각이 똑같아졌다. 어느 쪽으로도 끌 수 없는 값이다.
    """
    if not chars:
        return
    known = [i for i, one in enumerate(chars) if one["at"] is not None]
    if not known:
        return

    # 앞머리 — 첫 아는 글자에서 **거꾸로** 한 칸씩 물러난다.
    head = known[0]
    for step, i in enumerate(range(head - 1, -1, -1), start=1):
        at = chars[head]["at"] - CRAMP_MS * step
        chars[i]["at"] = at
        chars[i]["end"] = at + CRAMP_MS

    # 꼬리 — 마지막 아는 글자의 끝에서 한 칸씩 나아간다.
    tail = known[-1]
    for step, i in enumerate(range(tail + 1, len(chars))):
        at = (chars[tail]["end"] or chars[tail]["at"]) + CRAMP_MS * step
        chars[i]["at"] = at
        chars[i]["end"] = at + CRAMP_MS

    # 사이 — 그 구간을 고르게 나눈다.
    for one, two in zip(known, known[1:]):
        holes = two - one - 1
        if holes <= 0:
            continue
        span = max(CRAMP_MS * (holes + 1), chars[two]["at"] - chars[one]["at"])
        each = span / (holes + 1)
        for step in range(1, holes + 1):
            at = int(chars[one]["at"] + each * step)
            chars[one + step]["at"] = at
            chars[one + step]["end"] = int(chars[one]["at"] + each * (step + 1))
        chars[one]["end"] = chars[one + 1]["at"]


def loosen_chars(chars: list[dict]) -> None:
    """사람이 낼 수 없이 촘촘한 자리를 편다. **글자를 다 채운 뒤에** 한다.

    되풀이되는 구절에서는 정렬이 한쪽을 좁은 자리에 욱여넣는다 — 「잠깐이면 돼 잠깐이면」의
    앞쪽이 20ms 씩 붙었다. 초당 오십 음절이라 사람이 낼 수 없다. 숫자가 나왔다고 맞은 것이
    아니므로 적어도 **낼 수 있는 간격**으로는 펴 둔다. 그 대목은 어차피 미심쩍은 것으로
    표시되어 사람이 볼 자리다.

    앞에서 뒤로 한 번만 훑는다. 앞판은 촘촘한 덩이를 찾아 그 안에서 고르게 나눴는데, 편
    것이 **다음 글자 자리를 침범해** 두 글자가 같은 시각이 됐다. 밀린 만큼은 뒤로 번지지만,
    차례가 뒤집히거나 겹치는 것보다는 낫다.
    """
    if any(one["at"] is None for one in chars):
        return
    for index in range(1, len(chars)):
        least = chars[index - 1]["at"] + CRAMP_MS
        if chars[index]["at"] < least:
            chars[index]["at"] = least
    # 끝은 **다음 글자가 시작할 때까지** 이어 붙인다. 사이를 비워 두면 화면에서 글자가
    # 번쩍 켜졌다 멈추고 다음까지 기다린다 — 노래는 그렇게 들리지 않는다.
    for one, two in zip(chars, chars[1:]):
        one["end"] = max(one["at"] + 20, min(two["at"], one["at"] + HOLD_MS))
    if chars:
        last = chars[-1]
        last["end"] = max(last["end"] or 0, last["at"] + CRAMP_MS)


def whole_logits(audio):
    """곡 전체의 프레임별 확률. 겹쳐 자른 조각으로 추론하고 이어 붙인다.

    한 번에 넣을 수는 없다. wav2vec2 의 어텐션이 길이의 제곱으로 자라서 4 분(1 만 2 천 프레임)
    이면 메모리가 감당이 안 된다. 대신 30 초씩 자르되 **앞뒤로 2 초씩 더 물려** 추론하고 그
    물린 부분은 버린다 — 조각의 가장자리는 앞뒤 맥락이 없어 확률이 흔들린다.

    이어 붙인 뒤에는 맞추기를 **한 번만** 한다. 줄마다 창을 씌우던 앞판은 창의 끝이 틀리면
    남은 글자가 마지막 몇 프레임에 몰렸는데(0.02 초씩 붙었다), 그 창이 아예 없어진다.
    """
    import torch
    _, model = load()
    where = _bundle.get("where", "cpu")
    total = audio.shape[-1]

    # 모델이 바라는 대로 정규화한다(`do_normalize: True`).
    #
    # 이걸 안 하고 날것을 그대로 넣고 있었다. 훈련 때와 다른 크기의 소리를 넣은 셈이라
    # 확률이 통째로 흐려진다 — 「대체로 맞는데 가끔 놓친다」의 큰 몫이 여기 있었다.
    #
    # 곡 전체를 한 번에 정규화한다. 조각마다 따로 하면 조용한 대목의 조각이 크게 부풀려져
    # 이음새에서 확률이 튄다.
    voice = audio.to(torch.float32)
    voice = (voice - voice.mean()) / (voice.std() + 1e-7)

    # 조각을 **프레임 격자에 맞춰** 자른다.
    #
    # wav2vec2 는 320 표본(20ms)마다 한 프레임을 낸다. 앞판은 조각마다 `길이/프레임수` 로
    # 되짚어 반올림했는데, 그 오차가 조각마다 쌓여 곡 뒤로 갈수록 시각이 밀렸다.
    stride = 320
    step = (30 * SAMPLE_RATE // stride) * stride
    edge = (2 * SAMPLE_RATE // stride) * stride

    pieces = []
    at = 0
    while at < total:
        stop = min(total, at + step)
        left = max(0, at - edge)
        right = min(total, stop + edge)
        with torch.inference_mode():
            # torchaudio 의 모델은 `(확률, 길이)` 짝으로 돌려준다. 트랜스포머 판의
            # `.logits` 와 다르다.
            got = model(voice[..., left:right].to(where))[0].cpu()
        # 물려 넣은 만큼은 프레임 수로 바로 셀 수 있다 — 격자에 맞춰 잘랐으므로.
        head = (at - left) // stride
        tail = (right - stop) // stride
        pieces.append(got[:, head: got.shape[1] - tail if tail else None])
        at = stop
    return torch.log_softmax(torch.cat(pieces, dim=1), dim=-1)


def read_audio(path: Path, rate: int = SAMPLE_RATE, channels: int = 1):
    """어떤 형식이든 원하는 표본율·갈래 수로 읽어 온다. 기본은 맞추기가 바라는 16 kHz 홑소리.

    `torchaudio.load` 는 2.11 부터 제 디코더를 버리고 torchcodec 을 부른다. 그것을 또 깔아
    판을 맞추느니 이미 있는 ffmpeg 로 읽는다 — 되감기·리샘플링까지 한 번에 해 준다.

    표본율을 고를 수 있어야 하는 이유가 있다. **소리를 가르는 모델들은 44.1 kHz 스테레오로
    훈련됐다.** 16 kHz 홑소리로 줄여 놓고 넣으면 8 kHz 위가 통째로 비어 있고 스테레오도
    없어서 제대로 못 가른다 — 리드·서브가 「심하게 깨져」 들린 것이 그것이다. 맞추기에
    쓸 때만 16 kHz 로 줄인다.
    """
    import numpy
    import torch
    got = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", str(path),
         "-f", "f32le", "-ac", str(channels), "-ar", str(rate), "-"],
        stdin=subprocess.DEVNULL, capture_output=True, timeout=600)
    if got.returncode != 0 or not got.stdout:
        raise RuntimeError(f"음원을 못 읽는다: {got.stderr.decode()[-200:]}")
    samples = numpy.frombuffer(got.stdout, dtype=numpy.float32).copy()
    # ffmpeg 는 갈래를 엮어서 준다(L R L R …). 갈래마다 한 줄이 되게 편다.
    return torch.from_numpy(samples).reshape(-1, channels).T.contiguous()


def write_audio(wave, path: Path, rate: int) -> None:
    """`(갈래, 표본)` 을 wav 로 남긴다. 24 bit 로 둔다 — 갈래를 또 가를 것이라 여유를 남긴다."""
    import numpy
    flat = wave.T.contiguous().numpy().astype(numpy.float32)
    got = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-y",
         "-f", "f32le", "-ar", str(rate), "-ac", str(wave.shape[0]), "-i", "-",
         "-c:a", "pcm_s24le", str(path)],
        input=flat.tobytes(), capture_output=True, timeout=600)
    if got.returncode != 0:
        raise RuntimeError(f"소리를 못 남긴다: {got.stderr.decode()[-200:]}")


def vocals_of(path: Path) -> Path:
    """반주를 걷어 낸 보컬. 한 번 뽑아 두고 다시 쓴다.

    원곡을 그대로 맞추면 노래가 멎은 자리에도 모델이 반주를 듣고 아무 글자나 내놓는다.
    그래서 「여긴 빈칸」이 성립하지 않고, 줄 끝 낱말이 다음 줄 직전까지 늘어난다. Mora
    파이프라인이 demucs 를 먼저 돌리는 것도 같은 이유다.

    `htdemucs_ft` 를 쓴다. 네 모델을 겹쳐 돌려 네 배(4 분 곡에 2.5 분쯤) 걸리지만 **한 번만**
    하고 캐시된다. 처음엔 빠른 `htdemucs` 로 두었는데, 새어 든 반주가 그대로 맞추기의
    흔들림이 된다 — 곡당 2 분을 아끼자고 정확도를 내줄 자리가 아니다. Mora 파이프라인도
    ft 를 쓴다.
    """
    made = path.with_suffix(".vocals.wav")
    if made.exists():
        return made

    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    where = device()
    model = get_model("htdemucs_ft")
    # **원본을 원음질 그대로 읽는다.** 앞판은 16 kHz 홑소리로 읽어 놓고 다시 44.1 kHz 로
    # 늘려 demucs 에 넣었다 — 8 kHz 위를 먼저 버리고 없는 것을 만들어 낸 셈이라, 반주가
    # 새어 들고 갈래마다 소리가 상했다. demucs 가 바라는 그대로 넣는다.
    wave = read_audio(path, rate=model.samplerate, channels=2)
    with torch.inference_mode():
        stems = apply_model(model.to(where), wave[None].to(where), device=where, progress=False)
    voice = stems[0, model.sources.index("vocals")].cpu()

    # **원음질 스테레오로 남긴다.** 이 파일은 두 곳에 쓰인다 — 여기서 다시 리드/서브로
    # 가르고(그 모델도 44.1 kHz 스테레오를 바란다), 사람이 작업실에서 듣는다. 맞추기에
    # 넣을 때만 `read_audio` 가 16 kHz 홑소리로 줄여 준다.
    write_audio(voice, made, model.samplerate)
    return made


def voices_of(path: Path) -> tuple[Path, Path]:
    """보컬을 **리드**와 **서브**(백보컬·애드리브)로 가른다. 한 번 갈라 두고 다시 쓴다.

    왜 가르는가. 강제 정렬은 **차례를 지킨다** — 가사의 글자를 적힌 순서대로만 소리에 붙일 수
    있다. 그런데 백보컬은 리드와 **같은 때에** 불린다. 가사 파일에는 앞뒤로 적혀 있으니
    정렬은 그 둘을 차례로 놓으려 하고, 그러다 한 줄이 다른 줄의 소리까지 먹는다 —
    Small girl 의 「(If, if I got a…)」 가 한 번은 0.88 초에 눌리고 다음 번은 10.23 초로
    뻗은 것이 그것이다. **한 갈래 소리에 두 목소리가 섞여 있는 한 이건 못 고친다.**

    demucs 로는 안 된다. 보컬이 한 갈래(`drums·bass·other·vocals`)라 리드와 백이 같이 나온다.
    UVR 계열 카라오케 모델이 그 둘을 가른다 — `mel_band_roformer_karaoke_aufr33_viperx`.

    **XPU 로 돌린다.** audio-separator 는 cuda·mps·directml 만 보고 Arc 를 못 찾아 CPU 로
    떨어지는데, 그러면 4 분 곡에 **20 분 51 초**가 걸려 못 쓴다. 만든 뒤 `torch_device` 를
    갈아 끼우면 4 분으로 준다 — 5.4 배다.
    """
    lead = path.with_suffix(".lead.wav")
    back = path.with_suffix(".back.wav")
    if lead.exists() and back.exists():
        return lead, back

    import torch
    from audio_separator.separator import Separator

    voice = vocals_of(path)
    into = path.parent / "split"
    into.mkdir(exist_ok=True)
    apart = Separator(output_dir=str(into), output_format="WAV", log_level=40)
    apart.torch_device = torch.device(device())
    apart.load_model(model_filename="mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt")
    made = apart.separate(str(voice))

    # **이름으로 고르면 안 된다.** 이 모델은 `(Vocals)` 가 백보컬이고 `(Instrumental)` 이
    # 리드다 — 카라오케 모델은 「반주 = 리드 뺀 나머지」라는 뜻으로 이름을 붙이는데, 우리는
    # 이미 반주를 걷어 낸 보컬을 넣으므로 그 뜻이 뒤집힌다. 이름을 믿었다가 리드와 서브를
    # 거꾸로 붙였고, 사용자가 「서브라는데 메인 목소리가 그대로 있다」고 짚어 줘서 알았다.
    #
    # 소리 크기로 정한다. 리드가 백보컬보다 크다 — 재 보니 0.1248 대 0.0279 로 4.5 배였다.
    # 판이 바뀌어도 이 성질은 안 바뀐다.
    import torch  # noqa: F401  (read_audio 가 쓴다)

    loud = []
    for name in made:
        got = into / name
        if got.exists():
            loud.append((float(read_audio(got).pow(2).mean().sqrt()), got))
    if len(loud) < 2:
        raise RuntimeError(f"갈래가 둘이 아니다: {made}")
    loud.sort(reverse=True)
    for want, (_, got) in zip((lead, back), loud):
        # **원음질 그대로 옮긴다.** 16 kHz 홑소리로 줄여 두었더니 사람이 작업실에서 들을 때
        # 「심하게 깨져」 들렸다. 맞추기에 넣을 때만 `read_audio` 가 줄인다 — 줄여서 남길
        # 이유가 없다.
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(got),
                        "-c:a", "pcm_s24le", str(want)], check=True, timeout=600)
    for _, got in loud:
        got.unlink(missing_ok=True)
    return lead, back


def weigh(log_probs, tokens: list[int], since: int, until: int):
    """[since, until) 프레임 안에서만 맞춰 보고 **토큰당 평균 점수**와 첫 토큰 자리를 준다.

    합이 아니라 평균인 것은 창마다 길이가 달라서다. 합으로 재면 긴 창이 늘 이긴다.
    """
    import torch
    import torchaudio.functional as F

    piece = log_probs[:, since:until]
    if piece.shape[1] < len(tokens) or not tokens:
        return None
    try:
        paths, scores = F.forced_align(piece, torch.tensor([tokens]), blank=0)
    except Exception:
        return None
    merged = F.merge_tokens(paths[0], scores[0], blank=0)
    if len(merged) != len(tokens):
        return None
    return float(scores[0].sum()) / len(tokens), since + merged[0].start


def rethink(log_probs, tokens, heads, spans, lines, merged, per_frame):
    """밖에서 온 줄 시각과 크게 어긋난 줄을 **소리의 증거로** 다시 따진다.

    왜 이게 필요한가. 곡 전체를 한 번에 맞추면 되풀이되는 구절에서 엉뚱한 자리를 붙잡는다 —
    「그럼에도 불구하고」가 곡에 세 번 나오고 소리에는 가사에 안 적힌 되풀이가 더 있으면,
    정렬은 앞쪽 것을 집는다. 25 번과 27 번이 다 맞는데 26 번만 2.66 초 앞으로 끌려갔다.

    그런데 **밖에서 온 시각 쪽으로 무조건 끌면 안 된다.** 재 보니 크게 어긋난 줄의 절반은
    우리가 옳았다 — 파란달팽이 47·48 번과 Small girl 60·61·62 번은 우리 자리가 토큰당
    2.7~6.0 만큼 더 그럴듯했다. 유튜브 음원과 네이버 마스터의 편곡이 다르거나 밖에서 온
    시각이 틀린 것이다. 무조건 끌었으면 그 곡들을 14 초씩 망가뜨렸다.

    그래서 **모델에게 묻는다.** 두 자리에서 같은 길이의 창으로 각각 맞춰 보고, 밖에서 온
    자리가 `EVIDENCE` 넘게 나을 때만 옮긴다. 이건 앞서 실패한 「어긋난 줄만 그 앞뒤 사이에서
    다시 정렬」과 다르다 — 그건 같은 창 안에서 같은 답을 되돌려 받는 헛일이었지만, 여기서는
    **밖에서 온 시각**이라는 새 정보로 **다른 창**을 만들어 견준다.

    돌려주는 것은 못 박을 자리 목록 — (토큰 번호, 프레임).
    """
    if not heads:
        return []
    # 곡 전체가 통째로 밀린 것은 정렬의 흔들림이 아니라 음원 판이 다른 것이다. 빼고 본다.
    gaps = [merged[head].start * per_frame - lines[index]["at"]
            for index, head in enumerate(heads)
            if head is not None and lines[index].get("at") is not None]
    if not gaps:
        return []
    bias = sorted(gaps)[len(gaps) // 2]

    # 줄마다 어디서 어디까지 놓였나. 아래 두 시험이 다 이것을 본다.
    reach = {}
    for index, head in enumerate(heads):
        if head is None or not spans[index]:
            continue
        last = head + spans[index] - 1
        reach[index] = (merged[head].start, merged[last].start, spans[index])

    # ── 시험 1: 구조가 깨졌는가 ───────────────────────────────────────
    #
    # 점수 대질(아래)로는 되풀이를 못 가른다. 같은 구절이 두 번 나오면 **두 창이 다 그
    # 구절을 담고 있어서**, 어느 쪽이 옳은지가 아니라 어느 쪽이 더 또렷한지를 고르게 된다.
    #
    # 그래서 소리를 묻지 않고 **결과가 스스로 모순인가**를 본다. Small girl 18·19 번이 그렇다 —
    # 18 번은 0.88 초에 12 자(최소 간격에 붙음), 19 번은 10.23 초에 12 자인데 둘의 구간이
    # 겹친다. 두 줄이 같은 소리 위에 포개진 것이다. 정상적인 정렬은 이렇게 안 생긴다.
    #
    # 이때는 밖에서 온 시각을 **점수를 묻지 않고** 믿는다. 다만 함부로 못 옮기게, 못은
    # 그 깨진 짝이 이미 차지한 구간 **안에만** 박는다 — 이미 우리 것이라고 본 소리를
    # 다시 나누는 것이지, 딴 데로 데려가는 것이 아니다. 판이 다른 곡(파란달팽이·Small girl
    # 뒷부분)을 14 초씩 망가뜨리던 길이 이 울타리로 막힌다.
    floor = CRAMP_MS / per_frame
    broken = set()
    for index in reach:
        start, stop, count = reach[index]
        before = reach.get(index - 1)
        # 앞줄과 구간이 겹친다 — 두 줄이 같은 소리를 나눠 갖고 있다.
        if before and start < before[1]:
            broken.add(index)
            broken.add(index - 1)
        # 글자가 죄다 최소 간격에 붙었다 — 정렬이 더 좁히려던 것을 규칙이 막은 자국이다.
        if count >= 4 and (stop - start) <= (count - 1) * floor + 1:
            broken.add(index)

    # 잇달아 나오는 같은 글월이 **간격이 어긋난 채 늘어난** 자리.
    #
    # Small girl 의 「(If, if I got a…)」 세 번(18·19·20)이 그렇다. 겹치지도 눌리지도 않아
    # 위의 두 시험에는 안 걸리는데, 줄 길이가 8.17·9.65 초로 다른 번(2~3 초)의 서너 배다.
    # 17 번이 49 초에 끝나고 21 번이 71.5 초에 시작하니 그 사이 22.5 초를 셋이 고르게 나눠
    # 가졌다 — 사이의 간주까지 먹은 것이다.
    #
    # 늘어남과 간격 어긋남을 **함께** 봐야 한다. 간격만 보면 밖에서 온 시각이 다른 판을
    # 가리킬 때 멀쩡한 줄을 흔들게 된다. 늘어남은 우리 결과 안의 모순이라 밖을 안 믿어도
    # 성립하고, 간격은 어디로 옮길지를 알려 준다.
    said_text = [" ".join(one.get("text", "").split()) for one in lines]
    twin = {}
    for index, text in enumerate(said_text):
        if index in reach and text:
            twin.setdefault(text, []).append(index)
    for index in list(reach):
        text = said_text[index]
        mates = [one for one in twin.get(text, []) if one != index]
        if not mates or lines[index].get("at") is None:
            continue
        # 이름을 조심한다. `spans` 는 이 함수의 인자(줄마다의 토큰 수)라 여기서 다시 쓰면
        # 가려져 엉뚱한 것을 센다.
        widths = sorted((reach[one][1] - reach[one][0]) for one in mates)
        mid = widths[len(widths) // 2]
        mine = reach[index][1] - reach[index][0]
        if mid > 0 and mine > mid * STRETCH:
            broken.add(index)

    pins = []
    for index, head in enumerate(heads):
        if head is None or lines[index].get("at") is None:
            continue
        ours = merged[head].start * per_frame
        said = lines[index]["at"] + bias
        if index in broken:
            # 깨진 짝이 함께 차지한 구간. 그 밖으로는 안 나간다.
            near = [one for one in (index - 1, index, index + 1) if one in reach]
            low = min(reach[one][0] for one in near) * per_frame
            high = max(reach[one][1] for one in near) * per_frame
            if low <= said <= high:
                pins.append((head, int(said / per_frame)))
                continue
        if abs(ours - said) <= SUSPECT_MS:
            continue
        mine = tokens[head: head + spans[index]]
        if not mine:
            continue
        # 두 창의 길이를 똑같이 맞춘다. 다르면 점수가 길이 때문에 갈린다.
        width = max(len(mine) * 120, 2500) + 2 * LOOK_MS
        weighed = []
        for middle_ms in (ours, said):
            since = max(0, int((middle_ms - LOOK_MS) / per_frame))
            until = min(log_probs.shape[1], int((middle_ms - LOOK_MS + width) / per_frame))
            weighed.append(weigh(log_probs, mine, since, until))
        if weighed[0] is None or weighed[1] is None:
            continue
        if weighed[1][0] - weighed[0][0] > EVIDENCE:
            pins.append((head, weighed[1][1]))

    # 못은 차례를 지키고 **토막마다 프레임이 남아야** 한다.
    #
    # 토큰 하나에 적어도 프레임 하나가 있어야 CTC 가 길을 만든다. 못을 촘촘히 박아 어느
    # 토막에 프레임이 모자라면 `pinned` 가 통째로 실패해 2 차가 아무 일도 못 한다 —
    # 여기서 거르는 편이 낫다. 앞의 못부터 차례로 넣으며 자리가 없는 것만 버린다.
    total = log_probs.shape[1]
    kept: list[tuple[int, int]] = []
    for head, frame in pins:
        before_head, before_frame = kept[-1] if kept else (0, 0)
        # 앞 못과의 사이, 그리고 곡 끝까지에 토큰을 담을 프레임이 있는가.
        if frame - before_frame < head - before_head:
            continue
        if total - frame < len(tokens) - head:
            continue
        kept.append((head, frame))
    return kept


def pinned(log_probs, tokens: list[int], pins):
    """못 박은 자리에서 갈라 토막마다 따로 맞추고 이어 붙인다.

    앞서 「줄마다 창을 씌워 따로 정렬」은 실패했다 — 창 끝이 조금만 틀려도 남은 글자가 그 창
    마지막 몇 프레임에 몰렸다. 여기가 다른 것은 **토막이 크고**(못은 곡에 한둘이다) 경계가
    소리의 증거로 고른 자리라는 점이다. 줄마다 자르는 것이 아니다.

    한 토막이라도 실패하면 **통째로 물러선다.** 반쯤 맞은 것을 내놓느니 원래 답이 낫다.
    """
    import torch
    import torchaudio.functional as F

    cuts = [(0, 0)] + list(pins) + [(len(tokens), log_probs.shape[1])]
    out = []
    for (head, since), (next_head, until) in zip(cuts, cuts[1:]):
        piece_tokens = tokens[head:next_head]
        if not piece_tokens:
            continue
        piece = log_probs[:, since:until]
        if piece.shape[1] < len(piece_tokens):
            return None
        try:
            paths, scores = F.forced_align(piece, torch.tensor([piece_tokens]), blank=0)
        except Exception:
            return None
        got = F.merge_tokens(paths[0], scores[0], blank=0)
        if len(got) != len(piece_tokens):
            return None
        for span in got:
            span.start += since
            span.end += since
        out.extend(got)
    return out if len(out) == len(tokens) else None


def align_song(path: Path, lines: list[dict], tokenize, separate: bool = True) -> list[list[dict]]:
    """곡 하나를 **한 번에** 맞춘다. 줄마다의 낱말 목록을 돌려준다.

    줄마다 창을 씌우지 않는다. 줄 시각은 **시작**만 찍힌 값이라 창의 끝을 어디로 잡아도
    틀리고, 틀리면 남은 글자가 마지막 몇 프레임에 몰려 0.02 초씩 붙는다. 곡 전체를 하나의
    토큰 줄로 놓고 맞추면 그 담이 아예 없어진다 — CTC 맞추기는 주어진 토큰 차례에 대해
    **전체가 가장 그럴듯한 길**을 찾으므로, 한 군데가 애매해도 뒤로 밀고 가지 않는다.

    줄 시각은 이제 맞추는 데 안 쓰고, 나온 결과를 줄에 되돌려 주는 데만 쓴다.
    """
    import torch
    import torchaudio.functional as F

    audio = read_audio(vocals_of(path) if separate else path)
    load()
    # MMS_FA 의 빈칸은 0 번이다. 한국어 ASR 모델을 쓰던 앞판은 이 번호를 잘못 잡아
    # 글자 「볍」 을 빈칸으로 치고 맞췄다 — 토크나이저에게 묻지 않고 짐작한 탓이다.
    blank = 0

    # 글자마다 로마자 토큰이 몇 개인지 세어 둔다. 그 덩이의 **첫 토큰**이 그 글자가
    # 시작하는 자리다.
    tokens: list[int] = []
    plan: list[list[list[tuple[str, int]]]] = []   # 줄 → 어절 → [(글자, 토큰 수)]
    # 줄마다 **첫 토큰이 몇 번째이고 몇 개인가.** 아래에서 그 줄만 따로 다시 따질 때 쓴다.
    heads: list[int | None] = []
    spans: list[int] = []
    for line in lines:
        rows: list[list[tuple[str, int]]] = []
        head, count = None, 0
        for word in tokenize(line.get("text", "")):
            row: list[tuple[str, int]] = []
            for grain in grains_of(speakable(word)):
                got = letters(grain)
                if got and head is None:
                    head = len(tokens)
                count += len(got)
                tokens.extend(got)
                row.append((grain, len(got)))
            rows.append(row)
        plan.append(rows)
        heads.append(head)
        spans.append(count)
    if not tokens:
        return [[] for _ in lines]

    log_probs = whole_logits(audio)
    if len(tokens) > log_probs.shape[1]:
        return [[] for _ in lines]

    paths, scores = F.forced_align(log_probs, torch.tensor([tokens]), blank=blank)
    merged = F.merge_tokens(paths[0], scores[0], blank=blank)
    if len(merged) != len(tokens):
        return [[] for _ in lines]

    per_frame = audio.shape[-1] / log_probs.shape[1] / SAMPLE_RATE * 1000

    # 2 차 — 되풀이 구절에서 엉뚱한 자리를 붙잡은 줄을 소리의 증거로 되짚는다.
    #
    # 증거가 뚜렷할 때만 옮긴다. 아무것도 안 옮길 때가 대부분이고, 그때는 1 차 답 그대로다.
    # 한 토막이라도 실패하면 통째로 물러선다 — 반쯤 고친 것보다 원래 답이 낫다.
    pins = rethink(log_probs, tokens, heads, spans, lines, merged, per_frame)
    if pins:
        again = pinned(log_probs, tokens, pins)
        if again is not None:
            merged = again

    # 글자마다의 시각. 다음 글자 시작까지 이어 붙인다 — CTC 가 내는 것은 「그 글자가 가장
    # 뚜렷한 프레임」이라 한 칸(20ms)인 일이 흔한데, 빈칸은 소리가 없다는 뜻이 아니라 그
    # 자리에서 무엇을 낼지 모델이 정하지 않았다는 뜻이다.
    # 시작을 일정하게 당긴다.
    #
    # CTC 는 글자마다 프레임을 하나만 쓰는데(peaky) 그 하나는 **그 글자가 가장 또렷한
    # 순간**이다. 한글 음절에서 그것은 모음 한가운데이고, 노래는 자음에서 시작한다. 그래서
    # 정렬이 통째로 늦는다 — 세 곡을 재니 +0.18·+0.22·+0.25 초로 곡을 가리지 않고 늦었다.
    # 음원이 달라 생긴 치우침이면 곡마다 제각각이어야 하는데 그렇지 않았다.
    #
    # 소리 크기로 음절마다 되짚어 보았다. 늦음은 줄었지만(+0.22 → +0.02) **일관성이 망가졌다**
    # — 치우침을 뺀 오차가 15ms 에서 135ms 로 나빠졌다. 글자마다 제각각 움직인 탓이다.
    # 가라오케에서는 일정하게 늦는 편이 들쭉날쭉한 것보다 낫다. 앞엣것은 빼면 되고 뒤엣것은
    # 못 고친다.
    #
    # 그래서 잰 만큼을 통째로 당긴다. 임의의 숫자가 아니라 세 곡에서 나온 값이다.
    # 다만 **앞 글자와의 간격을 넘지 않게** 당긴다.
    #
    # 모두를 똑같이 당겼더니 빠른 자리가 무너졌다. 글자 사이가 200ms 보다 촘촘한 대목(랩,
    # 빠른 후렴)에서 서로 부딪히고, 겹침을 막느라 20ms 간격으로 욱여넣어졌다 —
    # 「잠깐이면」이 42.93·42.97·43.01 로 붙은 것이 그것이다. 사람이 그 속도로 부르지 않는다.
    #
    # 앞 글자와의 사이를 반만 먹는다. 촘촘한 자리는 조금만, 넉넉한 자리는 200ms 를 다 당긴다 —
    # 어차피 고치려는 것은 「모음 한가운데에 찍힌다」는 성질이고, 그 어긋남도 음절이 짧으면
    # 함께 짧아진다.
    lead = int(ONSET_LEAD_MS / per_frame)
    peaks = [span.start for span in merged]

    # 줄 안이 크게 비는 자리는 여기서 못 고친다.
    #
    # 「숨 좀 쉬고 싶어서」의 `싶`(40.87)과 `어`(42.49) 사이가 1.62 초 빈다. 그 줄만 앞뒤
    # 자리 사이에서 다시 맞춰 보았지만 **똑같은 답이 나왔다** — 같은 log_probs 의 부분 창에서
    # 같은 토큰을 맞추면 원래 고른 길이 그 창 안에 그대로 있기 때문이다. 창을 좁히는 것으로는
    # 정렬이 이미 고른 길을 물리지 못한다.
    #
    # 모델이 `어` 를 그 자리에서 듣는다고 하는 것이므로, 고치려면 다른 모델이거나 사람이다.
    # 그 대목은 미심쩍은 것으로 표시되어 사람에게 간다.

    starts = []
    for index, peak in enumerate(peaks):
        room = peak if index == 0 else (peak - peaks[index - 1]) // 2
        starts.append(max(0, peak - min(lead, max(0, room))))
    # 그래도 차례가 뒤집히지 않게 한 번 더 본다.
    for index in range(1, len(starts)):
        starts[index] = max(starts[index], starts[index - 1] + 1)

    # 끝은 다음 봉우리까지로 둔다. 다시 맞춘 줄은 `merged` 의 끝과 어긋나므로 그것을
    # 그대로 쓰면 시작보다 앞선 끝이 나온다.
    marks = [[int(one * per_frame), int(max(peak + 1, span.end) * per_frame)]
             for one, peak, span in zip(starts, peaks, merged)]
    # 글자마다 얼마나 확신하는가.
    #
    # `merge_tokens` 가 주는 점수는 그 구간의 **평균** 로그확률이라 확신도로 못 쓴다. 길게
    # 끄는 글자는 뒤쪽 프레임이 평균을 끌어내려, 잘 맞춘 글자도 낮게 나온다 — 252 개 중
    # 168 개가 미심쩍은 것으로 뜬 것이 그래서다.
    #
    # 그래서 **절대 확률이 아니라 견줌**으로 잰다 — 그 자리에서 모델이 고른 것보다 이 글자가
    # 얼마나 못했나. 0 이면 모델도 같은 글자를 들었다는 뜻이고, 크게 음수면 다른 것을 듣고
    # 있는데 우리가 여기라고 우긴 것이다.
    #
    # 절대값으로 재면 못 쓴다. 읽는 말로 훈련된 모델에 노래를 넣으니 어디서나 확률이 낮고
    # (가운뎃값 −4.5, 1% 쯤), 잘 맞춘 글자까지 미심쩍은 것으로 뜬다. 실제로 252 개 중
    # 168 개가 그렇게 떴다.
    #
    # 최댓값을 쓰는 것은 CTC 가 글자마다 프레임을 하나만 쓰기 때문이다(peaky). 구간이 한
    # 칸이라 평균이든 최댓값이든 같은 값이지만, 길게 끄는 자리에서는 최댓값이 맞다.
    best = log_probs[0].max(dim=-1).values
    sure = []
    for peak, span in zip(peaks, merged):
        stop = min(log_probs.shape[1], max(peak + 1, peak + (span.end - span.start)))
        gap = (log_probs[0, peak:stop, int(span.token)] - best[peak:stop]).max()
        sure.append(float(gap))

    # 미심쩍은 자리는 **곡 안에서 견줘** 고른다.
    #
    # 절대 문턱을 두면 못 쓴다. 노래는 이 모델의 훈련 분포 밖이라 어디서나 낮게 나오고,
    # −1.5 로 자르면 252 개 중 159 개가 걸린다 — 그만큼 걸리면 짚어 주는 뜻이 없다.
    #
    # 그 곡의 분포에서 아래 꼬리만 고른다. 모델이 고르게 자신 없어 하는 것은 노래라서이고,
    # **유독 더 자신 없는 자리**가 실제로 어긋난 자리다.
    # 확신도는 둘로 갈린다. 모델이 같은 글자를 들은 자리는 **정확히 0**(고른 것과 같음)이고,
    # 아닌 자리는 −3 아래로 뚝 떨어진다. 고르게 낮은 것이 아니라 맞은 자리와 아닌 자리가
    # 뚜렷하다 — 「노래라서 다 낮다」고 읽은 앞판의 판단이 틀렸다.
    #
    # 그래서 사분위 같은 것으로 꼬리를 자를 게 아니라 **모델이 다른 글자를 들었는가**로
    # 가르면 된다. 3 nat(확률로 스무 배)이면 다른 소리를 들은 것으로 본다.
    shaky = [one < DOUBT for one in sure]
    for one, two in zip(marks, marks[1:]):
        # 다음 글자가 시작할 때까지 **늘린다**. 앞판은 여기에 `min` 을 써서 늘리려던 것을
        # 도로 깎았고, 246 개가 전부 0.02 초로 남았다.
        #
        # 다만 한없이 늘리지는 않는다. 줄과 줄 사이의 간주까지 이어 붙이면 그 줄 마지막
        # 글자가 8 초씩 차오른다 — 노래는 거기서 이미 멎었다.
        one[1] = max(one[0] + 20, min(two[0], one[0] + HOLD_MS))
    # 마지막 글자의 꼬리는 지지받는 데까지만 남긴다.
    best = log_probs[0].max(dim=-1).values
    edge = merged[-1].end
    while edge > merged[-1].start + 1 and float(best[edge - 1] - log_probs[0, edge - 1, tokens[-1]]) > SUPPORT:
        edge -= 1
    marks[-1][1] = max(marks[-1][0] + 20, min(int(edge * per_frame), marks[-1][0] + HOLD_MS))

    # 줄 → 어절 → 글자로 되접는다.
    out: list[list[dict]] = []
    at = 0
    for rows in plan:
        # 줄 안의 글자를 한 줄로 펴서 한꺼번에 채운다. 어절 안에서만 채우면 어절 전체가
        # 어휘 밖일 때(「괜」 같은 글자만으로 이뤄진 어절) 기댈 데가 없어 빈 채로 남는다.
        flat: list[dict] = []
        shape: list[int] = []
        for row in rows:
            shape.append(len(row))
            for letter, count in row:
                if count:
                    # 한 글자가 로마자 여러 자로 갔다 — 「괜」 은 `gwaen` 다섯 자다. 그 덩이의
                    # **첫 자가 시작하는 때**부터 **끝 자가 끝나는 때**까지가 그 글자다.
                    # 로마자 첫 자는 대개 첫소리 자음이라, 음절이 시작하는 자리와 맞는다.
                    one = marks[at][0]
                    two = marks[at + count - 1][1]
                    # 덩이 안에서 **가장 약한 자**를 그 글자의 확신도로 삼는다. 다섯 자 중
                    # 하나만 딴 데 붙어도 그 글자는 믿을 수 없다.
                    worst = min(range(at, at + count), key=lambda i: sure[i])
                    flat.append({"text": letter, "at": one, "end": max(two, one + 20),
                                 "sure": round(sure[worst], 3),
                                 **({"shaky": True} if any(shaky[at: at + count]) else {})})
                    at += count
                else:
                    # 어휘 밖 글자. 자리만 잡아 두고 아래에서 앞뒤 사이를 나눠 채운다.
                    # 어휘 밖 글자는 맞춘 것이 아니므로 언제나 미심쩍다.
                    flat.append({"text": letter, "at": None, "end": None,
                                 "sure": -9.0, "shaky": True})
        fill_gaps(flat)
        loosen_chars(flat)

        words_out: list[dict] = []
        cut = 0
        for size in shape:
            chars = flat[cut: cut + size]
            cut += size
            # 줄에 맞춘 글자가 하나도 없으면 시각이 없다. 빈 채로 두고 사람에게 넘긴다 —
            # 아무 숫자나 지어내면 「모델이 맞춰 준 것」으로 읽힌다.
            if not chars or chars[0]["at"] is None:
                continue
            words_out.append({
                "text": "".join(one["text"] for one in chars),
                "at": chars[0]["at"],
                "end": max(chars[-1]["end"], chars[0]["at"] + LEAST_MS),
                # 어절의 확신도는 그 안에서 가장 약한 글자를 따른다. 하나가 어긋나면
                # 그 어절은 믿을 수 없다.
                "sure": round(min(one["sure"] for one in chars), 3),
                **({"shaky": True} if any(one.get("shaky") for one in chars) else {}),
                "chars": chars,
            })
        out.append(words_out)
    flag_stuck(lines, out)
    return out


def align_voices(path: Path, lines: list[dict], tokenize, title: str = ""):
    """보컬을 리드/서브로 가른 뒤 **갈래마다 따로** 맞춘다. `(줄마다의 낱말, 줄마다의 갈래)`.

    왜 이렇게 하나. 강제 정렬은 차례를 지키므로 **동시에 불리는 두 목소리를 한 갈래 소리
    위에서는 표현할 수 없다.** 가사에 앞뒤로 적힌 두 줄이 소리에서 겹치면, 정렬은 둘을
    차례로 놓으려다 한쪽을 짓뭉갠다.

    갈래를 갈라 놓으면 그 다툼이 없어진다 — 리드 줄은 리드 소리 위에서, 서브 줄은 서브
    소리 위에서 **각각 차례를 지키면** 되고, 둘 사이에는 차례를 지킬 까닭이 없다.

    `align_song` 을 두 번 부른다. 다른 갈래의 줄은 글월을 비워 넘긴다 — 맞출 토큰이 없어
    건너뛰어지므로, 손댈 것 없이 그 갈래의 줄만 이어진 하나의 차례가 된다. 오래 다듬은
    `align_song` 을 그대로 두려고 이렇게 한다.
    """
    lead, back = voices_of(path)

    # 1. **리드 갈래** 위에서 모든 줄을 맞춘다.
    #
    #    줄을 빼지 않는 것이 중요하다. 갈래마다 제 줄만 남기고 따로 맞췄더니 무너진 줄이
    #    2 개에서 20 개가 됐다 — 줄을 빼면 그 차례에 구멍이 나고 남은 줄이 그것을 메우려 뻗는다.
    #
    #    바탕을 무엇으로 할지는 한 번 틀리게 답했다. 「카라오케 모델이 리드를 깎으니 demucs
    #    보컬이 낫다」고 적었는데, 그때 리드라고 부르던 파일이 실은 **백보컬**이었다. 이름을
    #    믿고 거꾸로 붙인 탓이다. 바로잡고 여덟 곡으로 다시 재니 리드 갈래가 낫다 —
    #    무너진 줄 18 개에서 14 개, 세 곡이 좋아지고 나빠진 곡은 없다.
    out = align_song(lead, lines, tokenize, separate=False)

    # 2. **이미 무너진 줄만** 서브 소리로 구제한다.
    #
    #    멀쩡한 줄은 손대지 않으므로 이 단계는 나빠질 수가 없다. 서브에서 더 잘 맞으면
    #    그 시각을 쓰고, 아니면 리드 것을 그대로 둔다.
    hurt = sorted(broken_lines(out))
    lanes: dict[int, int] = {index: 0 for index in range(len(lines))}
    if not hurt:
        return out, lanes

    # 서브 소리에서 **줄을 다 두고** 한 번 더 맞춘다. 이 판은 덤이라, 여기서 뭐가 나오든
    # 리드 판은 그대로다.
    #
    # 무너진 줄만 남겨 봤다가 크게 헛디뎠다. 네 줄만 두면 그것들이 곡 어디에나 갈 수 있어
    # **47~147 초씩 튀었다** — 「(If, if I got a…)」 는 곡에 열 번 넘게 나오니 어느 것에
    # 붙어도 점수가 좋다. 줄을 다 두면 차례가 그것들을 제자리 언저리에 묶는다.
    rescued = align_song(back, lines, tokenize, separate=False)

    for index in hurt:
        got = rescued[index]
        if not got or got[0].get("stuck"):
            continue
        was = [one for word in out[index] for one in (word.get("chars") or [])]
        now = [one for word in got for one in (word.get("chars") or [])]
        if not was or not now:
            continue
        # 너무 멀리 갔으면 안 믿는다. 서브 갈래에서 몇 줄만 맞추면 되풀이 구절이 곡 어디로든
        # 갈 수 있다 — 고치려는 것과 같은 병이다. 리드가 짚은 자리 언저리라야 구제로 친다.
        if abs(now[0]["at"] - was[0]["at"]) > RESCUE_REACH_MS:
            continue
        # 그 줄에서 가장 약한 글자끼리 견준다. 하나가 어긋나면 그 줄은 못 믿는다.
        before = min(one.get("sure", -9.0) for one in was)
        after = min(one.get("sure", -9.0) for one in now)
        if after - before <= VOICE_EDGE:
            continue
        out[index] = got
        lanes[index] = 1

    # 누가 부르는가. 제목에 `Feat.` 이 있는 곡만 가른다.
    #
    # 위의 서브 갈래 구제와는 **다른 것**을 잰다. 그것은 「화음이냐」이고 이것은 「누구냐」다.
    # 피처링 가수는 저 혼자 리드로 부르므로 카라오케 모델이 못 가른다 — 목소리가 확 바뀌는데
    # 안 갈라진다던 지적이 그 자리다.
    who = who_sings(lead, lines, out, title)
    for index, one in enumerate(who):
        if one:
            lanes[index] = one

    # 무너짐 표시를 **합친 뒤에 다시** 매긴다.
    #
    # `flag_stuck` 은 `align_song` 안에서 도니, 여기서 줄을 갈아 끼우면 표시가 옛 결과를
    # 가리킨 채로 남는다. 실제로 서버가 저장한 것과 probe 가 잰 것이 달라 한참 헤맸다 —
    # 화면이 보여 주는 것과 다른 것을 재고 있었다.
    #
    # 다시 매기면 구제가 옆줄에 남긴 자국도 드러난다. 18 번을 서브로 보내면 19 번이 그
    # 자리를 메우려 늘어나는 일이 있는데, 그것도 사람에게 보여야 한다.
    for words in out:
        for word in words:
            word.pop("stuck", None)
    flag_stuck(lines, out)
    return out, lanes


# 제목이 여럿이 부른다고 말해 주는 꼴들. 있으면 문턱을 낮춘다 — 없다고 솔로인 것은 아니다.
MANY_VOICES = re.compile(r"\b(feat\.?|featuring|with)\b", re.I)
# 한 사람의 자국도 노래에서는 흔들린다. 이보다 짧은 줄은 아예 안 쓴다.
VOICE_LEAST_MS = 1000
# 다른 사람이라고 보려면 **이어진 줄**이 이만큼은 되어야 한다.
#
# 왜 덩어리로 재는가. 사람이 바뀌면 그 사람이 한 대목을 통째로 부르므로 줄 번호가
# **이어진다.** 한 사람의 창법 변화는 곡 여기저기에 흩어진다.
#
# 값은 맞바꿈이라 고른 것이다. 아홉 곡으로 재니:
#
#   문턱 6 — 솔로 다섯 곡 하나도 안 갈림(좋다). 그런데 빅뱅 「붉은 노을」이 5 줄만 갈렸다.
#            멤버가 두세 줄씩 주고받는데 6 줄 덩어리가 안 나온다.
#   문턱 3 — 붉은 노을이 19 줄로 제대로 갈린다. 대신 솔로 곡 둘이 헛갈린다.
#
# **3 을 고른 이유는 두 실수의 값이 다르기 때문이다.** 이 번호는 시각을 안 건드린다 —
# 화면에 어느 칸에 그릴지, 무슨 색으로 칠할지만 정한다. 헛갈리면 보기 헷갈릴 뿐이지만,
# 못 갈리면 기능이 아예 없는 것이다.
#
# 더 나은 자를 네 번 찾다 실패했다. 거리 문턱(묶음이 15~47 개로 흩어짐), 실루엣 점수
# (**솔로가 피처링보다 높게 나옴** — 묶임새는 사람이 아니라 창법을 잰다), 제목의 `Feat.`
# (그룹을 통째로 놓침), 되풀이 구절의 한결같음(솔로 100% 대 여럿 79~83% 로 거꾸로).
VOICE_RUN = 3
# 제목이 여럿이라고 알려 주면 같은 값을 쓴다. 더 낮출 자리가 없다.
VOICE_RUN_TOLD = 3


def who_sings(stem: Path, lines: list[dict], out: list[list[dict]], title: str) -> list[int | None]:
    """줄마다 **누가 부르는가.** 0 = 가장 많이 부른 사람, 1·2 = 그다음. 못 정하면 None.

    카라오케 모델이 가르는 것은 「리드 대 화음」이지 **누구냐**가 아니다. 피처링 가수는
    저 혼자 리드로 부르므로 리드 갈래에 그대로 들어가고, 목소리가 확 바뀌어도 갈라지지
    않는다 — 사용자가 짚은 것이 그것이다.

    사람을 가르려면 목소리마다의 **자국**(speaker embedding)을 떠서 비슷한 것끼리 묶는다.
    `speechbrain` 의 ECAPA-TDNN 을 쓰고, **줄 단위로** 뜬다 — 소리를 창으로 훑어 화자 경계를
    찾는 흔한 방식을 안 쓰는 이유는 우리가 이미 줄이 언제부터 언제까지인지 알기 때문이다.

    **여럿인지 아닌지는 「덩어리짐」으로 정한다.** 세 번 헤매고 온 자리다:

    1. 거리 문턱으로 개수를 정해 보니 묶음이 15~47 개로 흩어졌다. ECAPA 는 말로 훈련된
       것이라 노래에서는 같은 사람의 자국도 음높이·창법에 따라 크게 흔들린다.
    2. 실루엣 점수로 골라 보니 **솔로 곡이 피처링 곡보다 높게 나왔다**(0.350 대 0.322).
       묶임새는 사람이 갈리는지가 아니라 **창법이 갈리는지**를 잰다.
    3. 제목의 `Feat.` 에 기댔더니 **그룹을 통째로 놓쳤다** — 빅뱅 같은 팀은 넷다섯이 번갈아
       부르는데 제목에는 아무 표시가 없다.

    되는 자는 **자리**다. 사람이 바뀌면 그 사람이 한 절을 통째로 부르므로 줄 번호가
    **이어진 덩어리**로 나온다. 한 사람의 창법 변화는 곡 여기저기에 흩어진다. 여덟 곡으로
    재니 다른 사람이 있는 곡의 가장 긴 덩어리는 7·12·11, 혼자인 곡은 4·1·5·1·2 였다.

    Small girl 로 재니 `[18, 19, 60, 61]` 만 따로 묶였다 — 사용자가 짚어 준 정답 그대로이고
    헛잡음이 없다(20·62 번은 1 초가 안 돼 측정에서 빠졌다).
    """
    import torch
    from sklearn.cluster import AgglomerativeClustering

    if "voice" not in _bundle:
        from speechbrain.inference.speaker import EncoderClassifier
        _bundle["voice"] = EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            savedir=str(Path(__file__).parent / "models/ecapa"),
            run_opts={"device": device()})
    model = _bundle["voice"]

    audio = read_audio(stem)[0]
    least = VOICE_LEAST_MS / 1000 * SAMPLE_RATE
    where, marks = [], []
    with torch.inference_mode():
        for index, words in enumerate(out):
            chars = [one for word in words for one in (word.get("chars") or [])]
            if not chars:
                continue
            since = int(chars[0]["at"] / 1000 * SAMPLE_RATE)
            until = int((chars[-1]["end"] or chars[-1]["at"]) / 1000 * SAMPLE_RATE)
            if until - since < least or since < 0 or until > audio.shape[-1]:
                continue
            where.append(index)
            marks.append(model.encode_batch(
                audio[since:until].unsqueeze(0).to(device())).squeeze().cpu())
    if len(marks) < 8:
        return [None] * len(out)

    stack = torch.stack(marks)
    stack = stack / stack.norm(dim=1, keepdim=True).clamp(min=1e-9)
    labels = AgglomerativeClustering(
        n_clusters=3, metric="cosine", linkage="average").fit(stack.numpy()).labels_

    # 많이 부른 사람이 0 번이다. 번호가 곡마다 뒤집히면 화면에서 읽을 수가 없다.
    groups: dict[int, list[int]] = {}
    for index, label in zip(where, labels):
        groups.setdefault(int(label), []).append(index)
    order = sorted(groups.values(), key=len, reverse=True)

    # 으뜸이 아닌 묶음이 **이어진 덩어리**를 이루는가. 아니면 창법이 갈린 것일 뿐이다.
    need = VOICE_RUN_TOLD if MANY_VOICES.search(title or "") else VOICE_RUN
    longest = 0
    for one in order[1:]:
        run = best = 1
        for a, b in zip(sorted(one), sorted(one)[1:]):
            run = run + 1 if b == a + 1 else 1
            best = max(best, run)
        longest = max(longest, best)
    if longest < need:
        return [None] * len(out)

    who: list[int | None] = [None] * len(out)
    for rank, one in enumerate(order):
        for index in one:
            who[index] = rank
    return who


def broken_lines(out: list[list[dict]]) -> set[int]:
    """무너진 줄의 번호. 표시된 것과 **앞줄과 겹친 것**을 함께 본다."""
    hurt = {index for index, one in enumerate(out) if one and one[0].get("stuck")}
    ends = []
    for one in out:
        chars = [c for word in one for c in (word.get("chars") or [])]
        ends.append((chars[0]["at"], chars[-1]["at"]) if chars else None)
    for index, (before, now) in enumerate(zip(ends, ends[1:]), start=1):
        if before and now and now[0] < before[1]:
            hurt.add(index)
            hurt.add(index - 1)
    return hurt


def flag_stuck(lines: list[dict], out: list[list[dict]]) -> None:
    """**밖의 시각을 안 쓰고** 무너진 줄을 짚어 사람에게 넘긴다. `out` 을 그 자리에서 고친다.

    왜 따로 두는가. 글자마다의 확신도(`DOUBT`)는 이 모델에서 힘이 약하다 — 재 보니 나쁜 줄
    다섯 개 중 둘만 잡았고, 넷을 잡으려고 문턱을 내리면 113 줄 중 94 줄이 노래졌다.
    한국어 ASR 모델에서는 확신도가 둘로 갈렸지만(맞으면 0, 아니면 −3 아래) MMS_FA 는
    이어져 있어 그 칼이 안 든다.

    밖에서 온 줄 시각으로 재는 것도 못 쓴다. 크게 어긋난 열다섯 줄을 소리로 대질해 보니
    **바이브 자리가 나은 것은 하나뿐**이었다 — 유튜브 음원과 네이버 마스터의 편곡이 다르면
    곡이 통째로 어긋나므로, 그 자로는 우리 실수와 판 차이를 못 가른다.

    그래서 **정렬 결과 안에서만** 이상함을 찾는다. 가장 잘 드는 것은 되풀이 견줌이다 —
    같은 글월을 같은 곡에서 부르면 길이가 비슷해야 한다. 「(If, if I got a…)」 가 한 번은
    0.88 초, 바로 다음은 10.23 초로 놓였다면 뒤엣것이 앞엣것의 소리까지 먹은 것이다.
    이건 밖의 시각을 하나도 안 쓰므로 음원 판이 달라도 흔들리지 않는다.
    """
    from collections import defaultdict

    shape: dict[int, tuple[int, int, int]] = {}   # 줄 → (글자 수, 길이, 가장 큰 틈)
    for index, words in enumerate(out):
        chars = [one for word in words for one in (word.get("chars") or [])]
        if len(chars) < 2:
            continue
        shape[index] = (
            len(chars),
            chars[-1]["at"] - chars[0]["at"],
            max(b["at"] - a["at"] for a, b in zip(chars, chars[1:])),
        )

    doubt: dict[int, list[str]] = defaultdict(list)

    same: dict[str, list[int]] = defaultdict(list)
    for index in shape:
        same[" ".join(lines[index].get("text", "").split())].append(index)
    for group in same.values():
        if len(group) < 2:
            continue
        spans = sorted(shape[one][1] for one in group)
        mid = spans[len(spans) // 2]
        if mid <= 0:
            continue
        for index in group:
            ratio = shape[index][1] / mid
            if ratio > STRETCH:
                doubt[index].append(f"같은 글월의 {ratio:.1f}배로 늘어남")
            elif ratio < 1 / STRETCH:
                doubt[index].append(f"같은 글월의 {ratio:.1f}배로 눌림")

    for index, (count, span, hole) in shape.items():
        # 글자가 죄다 **최소 간격에 붙어** 있으면 정렬이 더 좁히려던 것을 규칙이 막은 것이다.
        # 속도로 재면 짧은 줄이 억울하게 걸린다 — 세 글자는 최소 간격만 지켜도 초당 18 자다.
        if count >= 4 and span <= (count - 1) * CRAMP_MS + 20:
            doubt[index].append("글자가 모두 최소 간격에 붙음")
        if hole > STUCK_HOLE_MS:
            doubt[index].append(f"글자 사이가 {hole / 1000:.1f}초 빔")

    for index, why in doubt.items():
        for word in out[index]:
            word["shaky"] = True
        if out[index]:
            # 까닭은 줄의 첫 낱말에만 단다. 화면에서 줄 단위로 읽히면 된다.
            out[index][0]["stuck"] = " · ".join(why)
