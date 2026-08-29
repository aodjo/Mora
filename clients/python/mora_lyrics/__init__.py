"""
가사와 곡을 주면 낱말마다 언제 불렸는지 돌려준다.

    from mora_lyrics import Mora

    mora = Mora()
    timing = mora.align(lyrics, isrc="USA2P2607175")
    for line in timing.lines:
        print(line.start_ms, line.text)

타이밍은 Mora 가 이미 맞춰 둔 것을 가져온다. 이 라이브러리가 오디오를 듣지는 않는다.
"""

from .client import (
    Alignment,
    Line,
    Mora,
    MoraError,
    NotAligned,
    Speaker,
    Word,
)

__all__ = ["Alignment", "Line", "Mora", "MoraError", "NotAligned", "Speaker", "Word"]
__version__ = "0.1.0"
