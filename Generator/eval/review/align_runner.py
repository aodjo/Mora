#!/usr/bin/env python3
"""**워커가 부르는 정렬기.** 가사 줄만 받아(시각 없이) `align_voices` 로 맞추고, 줄마다 낱말·음절 시각을 JSON 으로 낸다.

워커 데몬(`Generator/python/mora_ml_daemon.py`)은 whisperx 를 torch 2.8 에서 돌리고, 이 정렬기는
torchaudio 2.11·torch 2.13 에 묶여 있어 한 살림에 못 산다. 그래서 데몬은 이 파일을 정렬기 살림의
파이썬으로 따로 띄우고, 이야기는 표준 입출력의 JSON 한 벌로 한다.

입력(표준 입력):
  {"audio": "/work/review/song.wav", "lines": ["가사 한 줄", …], "title": "곡 이름"}
출력(표준 출력):
  {"lines": [[{"text", "at", "end", "sure", "chars": [{"text", "at", "end", "sure"}]}], …],
   "lanes": {"줄 번호": 목소리}}
시각은 ms, 놓지 못한 낱말은 `at` 이 null 이다. 정렬기가 떠드는 것은 모두 표준 오류로 간다.

목소리 갈래(.vocals.wav · .lead.wav · .back.wav), 받아쓰기(.heard.json), 화자 가르기(.vocals.dia.json)는
음원 옆에 없으면 정렬기가 만들어 둔다. `.vocals.wav` 를 데몬이 미리 두면 목소리 분리를 한 번 던다.

@example
  echo '{"audio": "song.wav", "lines": ["첫 줄", "둘째 줄"]}' | MORA_MMS_WEIGHTS=b.pt python align_runner.py
"""
from __future__ import annotations

import json
import sys
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def plain(words: list[dict]) -> list[dict]:
    """Keep only what the worker needs from one line's words.

    @param {list[dict]} words - The aligner's word dicts for one line.
    @returns {list[dict]} Words with text, times, confidence and their syllables.
    """
    out = []
    for word in words or []:
        out.append({
            "text": word.get("text", ""),
            "at": word.get("at"),
            "end": word.get("end"),
            "sure": word.get("sure"),
            "chars": [{"text": one.get("text", ""), "at": one.get("at"), "end": one.get("end"), "sure": one.get("sure")}
                      for one in (word.get("chars") or [])],
        })
    return out


def main() -> int:
    """Read one request, align it, and write the answer.

    @returns {int} 0 on success; the process fails loudly on anything else so the daemon falls back.
    """
    asked = json.loads(sys.stdin.read())
    audio = Path(asked["audio"])
    lines = [{"text": str(text), "at": None} for text in asked["lines"]]
    with redirect_stdout(sys.stderr):
        import align
        from probe_blind import words_of

        out, lanes = align.align_voices(audio, lines, words_of, str(asked.get("title", "")))
    json.dump({"lines": [plain(words) for words in out], "lanes": {str(index): lane for index, lane in lanes.items()}},
              sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
