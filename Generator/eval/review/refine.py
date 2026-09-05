#!/usr/bin/env python3
"""**줄 안의 음절 자리를 Qwen3-ForcedAligner 로 다시 놓는다.** 정렬기와 따로 도는 한 단계.

왜 따로인가. 정렬기(MMS_FA)는 곡 전체의 CTC 확률 위에서 줄 자리를 잡고 되짚고 시계에 맞추는
데는 강한데, 빠른 랩 대목에서 음절을 못 듣는다 — 고스트시티 16 번 열네 음절 가운데 셋만 들었고
나머지는 칸에 고르게 펴 놓았다. Qwen3-ForcedAligner 는 그 줄의 열네 음절을 전부 소리 솟는
자리 40 ms 안에 놓는다. 열 곡에서 낱자가 소리와 50 ms 안에 든 비율이 46% → 56%.

대신 이 모델은 **짧은 발화용**이다. 곡을 통째로 넣으면 무너진다(139 초에 128 단위, 줄 시작이
9.7 초 앞섬). 그래서 줄 자리는 정렬기가 잡고, 이 단계는 **그 창 안에서 음절만** 놓는다.

글은 정렬기와 같은 알갱이(`grains_of`)로 띄어 넣는다 — 한글은 음절 하나, 로마자 낱말은
통째로 하나. 그래야 돌아온 단위가 정렬기의 낱자와 하나씩 맞는다. 낱말 사이는 두 칸이다.

**딴 살림에서 돈다.** `qwen-asr` 이 torch 2.14 를 끌어오는데 정렬기는 2.13 이다. 한 살림에
넣었다가 torch 가 갈려 torchvision 이 깨진 일이 있어(`diarize.py` 참고) `~/qwen` venv 에서
이 파일만 돌리고, 표준 입출력으로 JSON 을 주고받는다.

들어오는 것 (stdin):
    {"audio": "<16 kHz 홑소리 wav>", "lines": [{"index": 16, "since": 63500, "until": 68900,
                                            "grains": ["근","본",…]}, …]}
나가는 것 (stdout):
    {"16": [[63800, 64120], [64120, 64440], …], …}   — 알갱이마다 [시작, 끝] ms, 곡 시계

@example
  ~/qwen/bin/python refine.py < request.json > answer.json
"""
import json
import sys
import tempfile
from pathlib import Path

#: 창 하나의 최대 길이(초). 이보다 길면 이 모델이 무너지기 시작한다 — 통째로 넣은 139 초가 그랬다.
LONGEST_S = 30.0


def main() -> int:
    """Read the request, align every line inside its own window, and answer in kind.

    A line whose unit count does not come back equal to its grain count is left out of the
    answer; the caller keeps what it had for that line. Nothing here decides where a line is —
    only where its syllables fall inside the window it was given.

    @returns {int} 0 on success, 1 when the request is unreadable.
    """
    import numpy
    import soundfile
    import torch
    from qwen_asr import Qwen3ForcedAligner

    try:
        ask = json.load(sys.stdin)
    except Exception as why:
        print(json.dumps({"말": f"요청을 못 읽음: {why}"}), file=sys.stderr)
        return 1

    wave, rate = soundfile.read(ask["audio"], dtype="float32", always_2d=True)
    wave = wave.mean(axis=1)
    if rate != 16_000:
        print(json.dumps({"말": f"16 kHz 가 아님: {rate}"}), file=sys.stderr)
        return 1

    where = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
    model = Qwen3ForcedAligner.from_pretrained("Qwen/Qwen3-ForcedAligner-0.6B",
                                               dtype=torch.float32, device_map=where)

    out: dict[str, list[list[int]]] = {}
    with tempfile.TemporaryDirectory() as room:
        piece = Path(room) / "line.wav"
        for line in ask["lines"]:
            grains = [one for one in line["grains"] if one]
            since, until = int(line["since"]), int(line["until"])
            if not grains or until - since < 200 or (until - since) / 1000 > LONGEST_S:
                continue
            chunk = wave[since * 16: until * 16]
            if chunk.size < 1600:
                continue
            soundfile.write(str(piece), chunk, 16_000)
            #: 알갱이 하나가 단위 하나다 — 한글은 음절, 로마자는 낱말. 모델은 빈칸으로 단위를 가르므로
            #: 그냥 한 칸씩 띄운다. 돌아온 단위 수가 알갱이 수와 다르면 그 줄은 버린다.
            text = " ".join(grains)
            try:
                units = list(model.align(audio=str(piece), text=text, language="Korean")[0])
            except Exception as why:
                print(json.dumps({"줄": line["index"], "말": str(why)[:120]}), file=sys.stderr)
                continue
            if len(units) != len(grains):
                continue
            spans = [[since + int(one.start_time * 1000), since + int(one.end_time * 1000)]
                     for one in units]
            if any(b[0] < a[0] for a, b in zip(spans, spans[1:])):
                continue
            out[str(line["index"])] = spans

    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
