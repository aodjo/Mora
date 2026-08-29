#!/usr/bin/env python3
"""모델 어휘가 자모인지 음절인지 본다. 여기가 어긋나면 한 줄도 못 맞춘다."""
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from transformers import Wav2Vec2Processor  # noqa: E402

MODEL = "kresnik/wav2vec2-large-xlsr-korean"
processor = Wav2Vec2Processor.from_pretrained(MODEL)
vocab = processor.tokenizer.get_vocab()
print(f"어휘 {len(vocab)}개")
keys = sorted(vocab, key=lambda k: vocab[k])
print("앞 40개:", " ".join(repr(k) for k in keys[:40]))

sample = "영원을 꿈꾸던 널"
print(f"\n시험 글자 {sample!r}")
for label, form in (("그대로(NFC)", unicodedata.normalize("NFC", sample)),
                    ("자모(NFD)", unicodedata.normalize("NFD", sample))):
    hit = [c for c in form if c != " " and c in vocab]
    miss = [c for c in form if c != " " and c not in vocab]
    print(f"  {label:<12} 맞음 {len(hit):>3} · 없음 {len(miss):>3}  없는 것: {''.join(miss[:12])}")

print("\n특수 토큰:", {k: v for k, v in vocab.items() if len(k) > 1})
