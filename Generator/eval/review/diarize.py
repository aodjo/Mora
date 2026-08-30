#!/usr/bin/env python3
"""**누가 언제 부르는가를 겹침까지 담아 내보낸다.** 정렬기와 따로 도는 한 단계.

왜 따로 도는가. 지금 쓰는 ECAPA 자국은 **말**로 배운 것이라 노래에서 심하게 흔들리고, 무엇보다
줄마다 자국 하나를 떠서 「이 줄은 누구」만 말할 수 있다. 두 사람이 **동시에** 부르는 대목은
그 틀로는 표현이 안 된다 — 한 줄에 사람이 하나뿐이니까.

Sortformer 는 소리를 통째로 받아 사람마다 「지금 부르고 있나」를 프레임마다 내놓는다. 둘이
같이 부르면 두 줄기가 동시에 켜지므로 **겹침이 그냥 나온다.**

pyannote 쪽(3.1·community-1)이 먼저였는데 무게가 전부 문 뒤에 있다(401). Sortformer 는
문이 없어 토큰 없이 받아진다.

**딴 살림에서 돈다.** `nemo_toolkit` 이 torch 2.8 이상을 달라고 하는데 정렬기는 2.7 에
묶여 있다(torchaudio·MMS_FA). 한 살림에 넣었더니 pip 이 torch 를 2.13 으로 올려 torchvision
까지 깨뜨렸다. 그래서 `~/dia` venv 에서 이 파일만 돌리고 결과는 JSON 으로 건넨다.

@example
  ~/dia/bin/python diarize.py audio/UIBmWmDP1RU.vocals.wav out.json
"""
import json
import sys
from pathlib import Path

#: 사람이 부르고 있다고 볼 문턱. Sortformer 는 사람마다 0~1 을 낸다.
SINGING = 0.5
#: 이보다 짧은 토막은 버린다(초). 숨소리 하나에 사람이 바뀌었다고 하지 않으려고.
LEAST = 0.30
#: 모델은 16 kHz 홑소리를 받는다.
RATE = 16_000


def runs_of(marks, per_frame: float, who: int) -> list[tuple[float, float]]:
    """Turn one speaker's frame-by-frame activity into a list of stretches.

    @param {list[float]} marks - Activity of this speaker, one value a frame.
    @param {float} per_frame - Seconds a frame covers.
    @param {int} who - Which speaker these marks belong to, used only for the log.
    @returns {list[tuple[float, float]]} Start and end of each stretch, in seconds.
    """
    out: list[tuple[float, float]] = []
    since = None
    for at, one in enumerate(marks):
        if one >= SINGING and since is None:
            since = at
        elif one < SINGING and since is not None:
            if (at - since) * per_frame >= LEAST:
                out.append((since * per_frame, at * per_frame))
            since = None
    if since is not None and (len(marks) - since) * per_frame >= LEAST:
        out.append((since * per_frame, len(marks) * per_frame))
    return out


def main() -> int:
    """Run Sortformer over one audio file and write who sings when.

    The file is fed as it is; Sortformer wants 16 kHz mono and NeMo resamples. The written JSON
    holds one entry a speaker, each with its stretches, so an overlap is simply two entries whose
    stretches cross.

    @returns {int} 0 on success, 1 when the audio is missing.
    """
    if len(sys.argv) < 3:
        print("쓰기: diarize.py <소리> <나갈 json>")
        return 1
    audio, into = Path(sys.argv[1]), Path(sys.argv[2])
    if not audio.exists():
        print(f"소리가 없다: {audio}")
        return 1

    from nemo.collections.asr.models import SortformerEncLabelModel

    model = SortformerEncLabelModel.from_pretrained("nvidia/diar_sortformer_4spk-v1")
    model.eval()

    got = model.diarize(audio=[str(audio)], batch_size=1, include_tensor_outputs=True)
    #: `(글, 값)` 을 준다. 글 쪽은 `"3.440 4.160 speaker_0"` 꼴로 이미 토막이 잘려 있지만
    #: 문턱을 우리가 못 고르므로 값 쪽을 쓴다. 값은 `[한 벌, 프레임, 사람]` 이다.
    marks = got[1][0] if isinstance(got, tuple) and len(got) > 1 and got[1] else None
    if marks is None:
        print(json.dumps({"쪽": [], "말": "겹침 값을 못 받음"}, ensure_ascii=False))
        return 1

    rows = marks.cpu().numpy() if hasattr(marks, "cpu") else marks
    while getattr(rows, "ndim", 2) > 2:
        rows = rows[0]
    frames, people = rows.shape
    #: Sortformer 는 80 ms 마다 한 값을 낸다. 소리 길이로 나눠 스스로 재는 편이 안전하다.
    import soundfile
    seconds = soundfile.info(str(audio)).duration
    per_frame = seconds / frames

    out = {"길이": round(seconds, 2), "사람": people, "프레임": round(per_frame, 4), "쪽": []}
    for who in range(people):
        runs = runs_of(rows[:, who], per_frame, who)
        held = sum(end - since for since, end in runs)
        out["쪽"].append({"누구": who, "부른 시간": round(held, 2),
                         "토막": [[round(a, 3), round(b, 3)] for a, b in runs]})

    #: 겹치는 시간. 이것이 있어야 「동시에 불렀다」를 말할 수 있다.
    together = 0.0
    for one in range(people):
        for two in range(one + 1, people):
            for a, b in out["쪽"][one]["토막"]:
                for c, d in out["쪽"][two]["토막"]:
                    together += max(0.0, min(b, d) - max(a, c))
    out["겹친 시간"] = round(together, 2)

    into.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  {audio.name} · 길이 {seconds:.1f}s · 사람 {people}명 · 겹침 {together:.1f}s")
    for one in out["쪽"]:
        print(f"    {one['누구']}번  부른 시간 {one['부른 시간']:>7.2f}s  토막 {len(one['토막']):>3}개")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
