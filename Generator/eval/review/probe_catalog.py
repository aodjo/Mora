#!/usr/bin/env python3
"""**쓸 수 있는 보컬 분리 모델을 다 훑는다.** 이름에 적힌 SDR 로 줄 세운다.

지금까지 일곱 개만 견줬다. 목록에 더 센 것이 있는지, 있다면 무엇인지 먼저 알아야 한다.

SDR 은 이름에 적힌 것만 읽는다 — 안 적힌 것은 모른다는 뜻이지 나쁘다는 뜻이 아니다.
같은 자로 잰 값도 아니므로(만든 이가 제각기 잰다) **줄 세우는 데만** 쓰고, 고르는 것은
우리 곡으로 직접 재서 정한다.
"""
import re
import sys

from audio_separator.separator import Separator

# 보컬 갈래가 아닌 것들. 이름으로 거른다.
SKIP = ("kara", "deverb", "denoise", "crowd", "aspir", "drum", "bass",
        "guitar", "piano", "reverb", "echo", "noise", "male", "female")

rows = []
for kind, models in Separator().list_supported_model_files().items():
    for name, info in models.items():
        if any(one in name.lower() for one in SKIP):
            continue
        got = info if isinstance(info, str) else info.get("filename", "")
        found = re.search(r"sdr[_ ]?([0-9]+\.[0-9]+)", f"{got} {name}", re.I)
        rows.append((float(found.group(1)) if found else 0.0, kind, name, got))

rows.sort(key=lambda one: -one[0])
how_many = int(sys.argv[1]) if len(sys.argv) > 1 else 30
print(f"  보컬 갈래 모델 {len(rows)}개 · 이름에 SDR 이 적힌 것부터\n")
print(f"  {'SDR':>6} {'갈래':<5} {'이름':<44} 파일")
for sdr, kind, name, got in rows[:how_many]:
    mark = f"{sdr:.2f}" if sdr else "?"
    print(f"  {mark:>6} {kind:<5} {name[:44]:<44} {got}")
