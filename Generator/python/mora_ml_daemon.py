#!/usr/bin/env python3
"""Long-running JSON-RPC ML daemon. Stdout is protocol-only; logs go to stderr."""
from __future__ import annotations

import importlib.util
from contextlib import redirect_stdout
import json
import math
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import traceback
import unicodedata
import wave
from pathlib import Path
from typing import Any


def command_exists(name: str) -> bool:
    return shutil.which(name) is not None


def module_exists(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except ModuleNotFoundError:
        return False


def detect_backend() -> tuple[str, str]:
    hardware = f"{platform.system()} {platform.machine()}"
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda", torch.cuda.get_device_name(0)
        if hasattr(torch, "xpu") and torch.xpu.is_available():
            return "xpu", str(torch.xpu.get_device_name(0))
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps", hardware
        if getattr(torch.version, "hip", None):
            return "rocm", hardware
    except Exception:
        pass
    return "cpu", hardware


def self_test() -> dict[str, Any]:
    backend, hardware = detect_backend()
    checks = {
        "yt-dlp": "passed" if command_exists("yt-dlp") else "failed",
        "ffmpeg": "passed" if command_exists("ffmpeg") and command_exists("ffprobe") else "failed",
        "htdemucs_ft": "passed" if module_exists("demucs") else "failed",
        "coarse_asr": "passed" if (backend == "mps" and module_exists("mlx_whisper")) or module_exists("whisperx") else "failed",
        "forced_align": "passed" if module_exists("whisperx") else "failed",
        "diarization": "passed" if module_exists("pyannote.audio") and bool(os.getenv("HF_TOKEN")) else "skipped",
    }
    required = ("yt-dlp", "ffmpeg", "htdemucs_ft", "coarse_asr", "forced_align")
    return {"backend": backend, "hardware": hardware, "checks": checks, "production_ready": backend != "cpu" and all(checks[key] == "passed" for key in required)}


def notify(stage: str, state: str, progress: float, metrics: dict[str, float] | None = None) -> None:
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "method": "stage", "params": {"stage": stage, "state": state, "progress": progress, "metrics": metrics or {}}}, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def run_command(args: list[str], code: str) -> None:
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        raise RuntimeError(code)


def probe(path: Path) -> dict[str, Any]:
    result = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        raise RuntimeError("FFPROBE_FAILED")
    return json.loads(result.stdout)


def downloaded(directory: Path) -> Path | None:
    candidates = [path for path in directory.glob("source.*") if path.suffix not in (".part", ".m4a")]
    return candidates[0] if candidates else None


def download(job: dict[str, Any], directory: Path, cookie_file: str | None) -> Path:
    urls = [job["source"]["url"], *job["source"].get("alternatives", [])]
    for url in urls:
        output = directory / "source.%(ext)s"
        args = ["yt-dlp", "--no-playlist", "--no-write-info-json", "-f", "bestaudio/best", "-o", str(output)]
        if cookie_file:
            args += ["--cookies", cookie_file]
        args.append(url)
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if result.returncode == 0:
            existing = downloaded(directory)
            if existing is not None:
                return existing
    raise RuntimeError("YTDLP_FAILED")


def transcode(source: Path, directory: Path) -> Path:
    output = directory / "mixture.wav"
    run_command(["ffmpeg", "-y", "-i", str(source), "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s24le", str(output)], "TRANSCODE_FAILED")
    return output


def separate(mixture: Path, directory: Path, backend: str) -> dict[str, Path]:
    output = directory / "demucs"
    stem_dir = output / "htdemucs_ft" / mixture.stem
    if not (stem_dir / "vocals.wav").exists():
        device = "mps" if backend == "mps" else "cuda" if backend == "cuda" else "cpu"
        run_command([sys.executable, "-m", "demucs", "-n", "htdemucs_ft", "--device", device, "--out", str(output), str(mixture)], "SEPARATION_FAILED")
    stems = {path.stem: path for path in stem_dir.glob("*.wav")}
    if "vocals" not in stems:
        raise RuntimeError("VOCALS_MISSING")
    return stems


def coarse_asr(vocals: Path, language: str, backend: str) -> tuple[dict[str, Any], str]:
    if backend == "mps":
        import mlx_whisper
        model = os.getenv("MORA_MLX_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
        with redirect_stdout(sys.stderr):
            result = mlx_whisper.transcribe(str(vocals), path_or_hf_repo=model, word_timestamps=True, language=None if language == "und" else language.split("-")[0])
        return result, str(result.get("language", language))
    import whisperx
    device = "cuda" if backend == "cuda" else backend
    compute_type = "float16" if backend in ("cuda", "xpu", "rocm") else "int8"
    with redirect_stdout(sys.stderr):
        model = whisperx.load_model("large-v3-turbo", device, compute_type=compute_type, language=None if language == "und" else language.split("-")[0])
        audio = whisperx.load_audio(str(vocals))
        result = model.transcribe(audio, batch_size=8)
    return result, str(result.get("language", language))


def alignable_languages() -> set[str] | None:
    """Language codes the forced aligner has a model for, or None when unknown."""
    try:
        from whisperx import alignment
        codes: set[str] = set()
        for name in ("DEFAULT_ALIGN_MODELS_TORCH", "DEFAULT_ALIGN_MODELS_HF"):
            codes.update(getattr(alignment, name, {}).keys())
        return codes or None
    except Exception:
        return None


def validate_language(detected: str, expected: str) -> None:
    """Reject only what the aligner cannot process; a mere mismatch stays reviewable."""
    supported = alignable_languages()
    code = detected.split("-")[0]
    if supported is not None and code not in supported:
        raise RuntimeError("UNSUPPORTED_LANGUAGE")
    notify("language_validate", "completed", 0.65, {"language_match": 1.0 if expected == "und" or code == expected.split("-")[0] else 0.0})


def audio_bounds(asr: dict[str, Any], duration_ms: int) -> tuple[float, float]:
    segments = asr.get("segments") or []
    if not segments:
        return 0.0, duration_ms / 1000.0
    return max(0.0, float(segments[0].get("start", 0))), min(duration_ms / 1000.0, float(segments[-1].get("end", duration_ms / 1000.0)))


def proportional_spans(counts: list[int], start: float, end: float) -> tuple[list[list[int]], list[list[int | float]]]:
    total = max(1, sum(max(1, count) for count in counts))
    cursor = start
    lines: list[list[int]] = []
    words: list[list[int | float]] = []
    token = 0
    for line_index, count in enumerate(counts):
        line_end = end if line_index == len(counts) - 1 else cursor + (end - start) * max(1, count) / total
        lines.append([round(cursor * 1000), round(line_end * 1000)])
        word_cursor = cursor
        for offset in range(count):
            word_end = line_end if offset == count - 1 else cursor + (line_end - cursor) * (offset + 1) / max(1, count)
            words.append([token, round(word_cursor * 1000), round(word_end * 1000), 0.25])
            word_cursor = word_end
            token += 1
        cursor = line_end
    return lines, words


def comparable(value: str) -> str:
    """Fold a word to what two transcriptions of the same sound would share."""
    return re.sub(r"[^\w]+", "", unicodedata.normalize("NFKC", value).lower(), flags=re.UNICODE)


def asr_words(asr: dict[str, Any]) -> list[dict[str, Any]]:
    """Every word the transcriber heard, in order, with the time it was heard at."""
    words: list[dict[str, Any]] = []
    for segment in asr.get("segments") or []:
        for word in segment.get("words") or []:
            text = comparable(str(word.get("word", word.get("text", ""))))
            if not text or "start" not in word or "end" not in word:
                continue
            words.append({"text": text, "start": float(word["start"]), "end": float(word["end"])})
    return words


def match_sequences(lyric: list[str], heard: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    """
    Which heard word each written word is, where the two agree.

    The transcriber mishears, skips and invents, so this is an alignment rather than a zip:
    Needleman-Wunsch over the two token sequences, keeping only the pairs that matched. The
    gaps between those anchors are what interpolation is for.
    """
    if not lyric or not heard:
        return {}
    rows, columns = len(lyric), len(heard)
    # Gap −1, match +2, mismatch −1: cheap to skip a word, expensive to claim a wrong one.
    scores = [[0.0] * (columns + 1) for _ in range(rows + 1)]
    for row in range(1, rows + 1):
        scores[row][0] = -row
    for column in range(1, columns + 1):
        scores[0][column] = -column
    for row in range(1, rows + 1):
        left_text = lyric[row - 1]
        for column in range(1, columns + 1):
            diagonal = scores[row - 1][column - 1] + (2.0 if left_text == heard[column - 1]["text"] else -1.0)
            scores[row][column] = max(diagonal, scores[row - 1][column] - 1.0, scores[row][column - 1] - 1.0)
    anchors: dict[int, dict[str, Any]] = {}
    row, column = rows, columns
    while row > 0 and column > 0:
        same = lyric[row - 1] == heard[column - 1]["text"]
        if scores[row][column] == scores[row - 1][column - 1] + (2.0 if same else -1.0):
            if same:
                anchors[row - 1] = heard[column - 1]
            row -= 1
            column -= 1
        elif scores[row][column] == scores[row - 1][column] - 1.0:
            row -= 1
        else:
            column -= 1
    return anchors


def anchored_windows(counts: list[int], words: list[str], heard: list[dict[str, Any]], start: float, end: float) -> list[list[int]] | None:
    """
    A time window per lyric line, taken from where those words were actually sung.

    Dividing the vocal region by word count assumes a song spends equal time on equal words,
    which no song does — it has an intro, a bridge, a held note, a repeated chorus. Feeding
    those guesses to the forced aligner then pins each line inside the wrong seconds of audio,
    and the aligner cannot escape the window it was given. Returns None when too little of the
    lyric was recognised to place anything, leaving the proportional guess as the fallback.
    """
    anchors = match_sequences(words, heard)
    if len(anchors) < max(4, len(words) // 12):
        return None
    # Anchor times are only known at matched words; the rest ride a line between them.
    known = sorted(anchors)
    positions: list[float] = []
    for index in range(len(words)):
        if index in anchors:
            positions.append(anchors[index]["start"])
            continue
        before = [key for key in known if key < index]
        after = [key for key in known if key > index]
        if before and after:
            low, high = before[-1], after[0]
            span = anchors[high]["start"] - anchors[low]["end"]
            positions.append(anchors[low]["end"] + span * (index - low) / (high - low))
        elif before:
            positions.append(anchors[before[-1]]["end"])
        elif after:
            positions.append(max(start, anchors[after[0]]["start"] - (after[0] - index) * 0.35))
        else:
            return None
    for index in range(1, len(positions)):
        positions[index] = max(positions[index], positions[index - 1])
    windows: list[list[int]] = []
    cursor = 0
    for count in counts:
        first = cursor
        last = min(len(positions) - 1, cursor + count - 1)
        line_start = positions[first]
        line_end = anchors[last]["end"] if last in anchors else positions[last] + 0.4
        if cursor + count < len(positions):
            line_end = min(max(line_end, line_start + 0.3), positions[cursor + count])
        windows.append([round(max(start, line_start) * 1000), round(min(end, max(line_end, line_start + 0.3)) * 1000)])
        cursor += count
    return windows


def fill_unaligned(words: list[dict[str, Any]], window_start: float, window_end: float) -> list[dict[str, Any]]:
    """
    Keep every word of the line, giving the ones the aligner skipped a place between their
    neighbours.

    The phoneme aligner returns a word per written word but leaves start and end off the ones
    it could not place — short unstressed words, mostly, "we" and "다" and the like. Dropping
    those was worse than it looks: what remains is projected onto the line's tokens by
    position, so losing one word slides every other word along. "we gonna" became two halves
    of "gonna", and the highlight for "we" appeared over a word it is not.

    A skipped word is not a missing word, only an untimed one. It sits between the word before
    and the word after, so that is where it goes; a run of them splits the gap evenly. Its
    score says it was placed rather than heard.
    """
    if not words:
        return []
    placed: list[dict[str, Any]] = []
    pending: list[dict[str, Any]] = []
    cursor = window_start
    for word in words:
        if "start" in word and "end" in word:
            start, end = float(word["start"]), float(word["end"])
            if pending:
                # Share the silence in front of this word among the ones with no time of their own.
                span = max(0.0, start - cursor)
                step = span / (len(pending) + 1)
                for index, gap_word in enumerate(pending):
                    gap_start = cursor + step * index
                    placed.append({**gap_word, "start": gap_start, "end": gap_start + step, "score": 0.3})
                pending = []
            placed.append({**word, "start": start, "end": end})
            cursor = end
            continue
        pending.append(word)
    if pending:
        span = max(0.0, window_end - cursor)
        step = span / len(pending) if span > 0 else 0.08
        for index, gap_word in enumerate(pending):
            gap_start = cursor + step * index
            placed.append({**gap_word, "start": gap_start, "end": gap_start + step, "score": 0.3})
    # A word can only be placed if something around it was heard.
    return placed if any("score" not in word or float(word.get("score", 0)) > 0.3 for word in placed) else []


def interpolate_boundaries(candidates: list[dict[str, Any]], count: int) -> list[list[int | float]]:
    """Project aligned ASR words onto the canonical tokenizer count without using text."""
    if count <= 0 or not candidates:
        return []
    boundaries = [float(candidates[0]["start"])]
    for index in range(1, len(candidates)):
        previous_end = float(candidates[index - 1]["end"])
        next_start = float(candidates[index]["start"])
        boundaries.append(max(boundaries[-1], (previous_end + next_start) / 2))
    boundaries.append(max(boundaries[-1], float(candidates[-1]["end"])))

    def sample(position: float) -> float:
        left = min(len(candidates) - 1, max(0, math.floor(position)))
        fraction = position - left
        return boundaries[left] + (boundaries[left + 1] - boundaries[left]) * fraction

    candidate_count = len(candidates)
    count_ratio = min(candidate_count, count) / max(candidate_count, count)
    average_score = sum(float(word.get("score", 0.75)) for word in candidates) / candidate_count
    score = max(0.0, min(1.0, average_score * count_ratio))
    projected: list[list[int | float]] = []
    for token_offset in range(count):
        start_position = token_offset * candidate_count / count
        end_position = (token_offset + 1) * candidate_count / count
        projected.append([
            token_offset,
            round(sample(start_position) * 1000),
            round(sample(end_position) * 1000),
            score,
        ])
    return projected


# 사람이 낼 수 있는 가장 짧은 음절. 이보다 짧게 잡혔다면 경계가 틀린 것이지 그렇게 부른 것이 아니다.
MIN_WORD_MS = 120.0


def widen_thin_words(words: list[list[int | float]], lines: list[list[int]], counts: list[int]) -> None:
    """
    Give a word that came out too short to see the time its neighbour took from it.

    A syllable cannot last forty milliseconds — "겨우 날 떼어" put 665ms on 겨우, 40ms on 날 and
    332ms on 떼어, and 날 flickers past unreadably. The aligner is not wrong that 날 is there or
    where in the order it falls; it is wrong about where 겨우 stopped, having run the two
    together. So the boundary moves rather than the word: the time comes out of whichever
    neighbour can spare it, starting with the one before, which is the one that swallowed it.

    Nothing is created and nothing is reordered — the line is as long as it was, and a word can
    only take from a neighbour that stays above the floor itself.
    """
    line_of_token: dict[int, int] = {}
    first_token: dict[int, int] = {}
    last_token: dict[int, int] = {}
    position = 0
    for line_index, count in enumerate(counts):
        if count <= 0:
            continue
        first_token[line_index] = position
        for offset in range(count):
            line_of_token[position + offset] = line_index
        last_token[line_index] = position + count - 1
        position += count

    for index, word in enumerate(words):
        duration = float(word[2]) - float(word[1])
        if duration >= MIN_WORD_MS:
            continue
        line_index = line_of_token.get(int(word[0]))
        if line_index is None:
            continue
        needed = MIN_WORD_MS - duration
        previous = words[index - 1] if index > 0 and line_of_token.get(int(words[index - 1][0])) == line_index else None
        following = words[index + 1] if index + 1 < len(words) and line_of_token.get(int(words[index + 1][0])) == line_index else None
        # The word before is the one that ran over, so it gives first.
        if previous is not None:
            spare = max(0.0, (float(previous[2]) - float(previous[1])) - MIN_WORD_MS)
            taken = min(needed, spare)
            if taken > 0:
                previous[2] = round(float(previous[2]) - taken)
                word[1] = previous[2]
                needed -= taken
        if needed > 0 and following is not None:
            spare = max(0.0, (float(following[2]) - float(following[1])) - MIN_WORD_MS)
            taken = min(needed, spare)
            if taken > 0:
                following[1] = round(float(following[1]) + taken)
                word[2] = following[1]
                needed -= taken
        # 줄 끝에 홀로 선 단어는 줄이 가진 여백에서 가져온다.
        if needed > 0 and previous is None and following is None:
            room = min(needed, max(0.0, float(lines[line_index][1]) - float(word[2])))
            word[2] = round(float(word[2]) + room)
        if int(word[0]) == first_token.get(line_index) and float(word[1]) < lines[line_index][0]:
            lines[line_index][0] = int(word[1])
        if int(word[0]) == last_token.get(line_index) and float(word[2]) > lines[line_index][1]:
            lines[line_index][1] = int(word[2])


def snap_line_starts(
    words: list[list[int | float]],
    lines: list[list[int]],
    counts: list[int],
    witness_ms: dict[int, float],
) -> None:
    """
    Pull a line's opening word off the noise in front of it.

    CTC alignment absorbs whatever sound precedes a line's first word into that word — a
    breath, a click, a synth swell reads as its opening consonant, and the highlight lights
    up on the noise. The transcriber is the counter-witness: it stamps a word where it heard
    it spoken, and noise rarely transcribes into the exact lyric word. So when the aligner
    starts a line well before the word was heard, the heard start wins; a small gap is
    ordinary jitter and stays with the aligner, which is the finer instrument.
    """
    first_token: dict[int, int] = {}
    position = 0
    for line_index, count in enumerate(counts):
        first_token[position] = line_index
        position += count
    for word in words:
        line_index = first_token.get(int(word[0]))
        if line_index is None:
            continue
        heard = witness_ms.get(line_index)
        if heard is None:
            continue
        start, end = float(word[1]), float(word[2])
        corrected = heard - 80.0  # a hair of onset grace
        if corrected - start < 250:
            continue  # disagreement small enough to be jitter, not noise
        corrected = min(corrected, end - 120.0)  # the word keeps a body
        if corrected <= start:
            continue
        word[1] = round(corrected)
        if line_index < len(lines) and lines[line_index][0] < word[1]:
            lines[line_index][0] = int(word[1])


def extend_held_endings(
    words: list[list[int | float]],
    lines: list[list[int]],
    last_token_of_line: dict[int, int],
    heard: list[dict[str, Any]],
) -> None:
    """
    Give a held final note the length it is held for.

    The phoneme aligner marks where a sound begins and loses interest once it stops changing,
    so "Fun~~~~" ends on paper the moment "Fun" has been said. Inside a line the next word's
    start already covers this; the last word of a line has nothing after it and kept its raw
    end, which is exactly where held notes live. The transcriber, however, heard the whole
    note — its word end sits where the voice actually stopped — so the line's last word may
    borrow that end when the transcriber heard something longer at the same spot.
    """
    for position, word in enumerate(words):
        line_index = last_token_of_line.get(int(word[0]))
        if line_index is None:
            continue
        word_start, word_end = float(word[1]), float(word[2])
        next_start = float(words[position + 1][1]) if position + 1 < len(words) else None
        # The longest ASR word still running at this word's start — the note as it was heard.
        heard_end = max(
            (h["end"] * 1000 for h in heard if h["start"] * 1000 <= word_start + 250 and h["end"] * 1000 > word_end),
            default=None,
        )
        if heard_end is None:
            continue
        extended = heard_end
        # Never into the next line's opening word.
        if next_start is not None:
            extended = min(extended, next_start - 40)
        if extended <= word_end:
            continue
        word[2] = round(extended)
        if line_index < len(lines) and lines[line_index][1] < word[2]:
            lines[line_index][1] = int(word[2])


def align_variant(vocals: Path, variant: dict[str, Any], asr: dict[str, Any], duration_ms: int, backend: str, detected: str = "und") -> dict[str, Any]:
    text_lines = [line for line in str(variant["text"]).splitlines() if line.strip()]
    counts = [int(value) for value in variant.get("token_counts", [])]
    if len(counts) != len(text_lines):
        counts = [max(1, len(line.split())) for line in text_lines]
    start, end = audio_bounds(asr, duration_ms)
    proportional_windows, fallback_words = proportional_spans(counts, start, end)
    # Where the transcriber actually heard these words beats dividing the song by word count.
    lyric_words = [comparable(word) for line in text_lines for word in line.split() if comparable(word)]
    heard_words = asr_words(asr)
    anchored = anchored_windows(counts, lyric_words, heard_words, start, end)
    # When was each line's first word heard — the counter-witness against leading noise.
    anchors = match_sequences(lyric_words, heard_words)
    line_start_witness_ms: dict[int, float] = {}
    word_offset = 0
    for line_index, line in enumerate(text_lines):
        line_word_count = len([word for word in line.split() if comparable(word)])
        opening = anchors.get(word_offset)
        if line_word_count > 0 and opening is not None:
            line_start_witness_ms[line_index] = float(opening["start"]) * 1000
        word_offset += line_word_count
    line_windows = anchored or [span[:] for span in proportional_windows]
    anchored_by_asr = anchored is not None
    try:
        import whisperx
        language = str(variant.get("language", "und")).split("-")[0]
        device = "cuda" if backend == "cuda" else "cpu" if backend == "mps" else backend
        with redirect_stdout(sys.stderr):
            model, metadata = whisperx.load_align_model(language_code=language, device=device)
            segments = [{"start": line_windows[index][0] / 1000, "end": line_windows[index][1] / 1000, "text": line} for index, line in enumerate(text_lines)]
            audio = whisperx.load_audio(str(vocals))
            aligned = whisperx.align(segments, model, metadata, audio, device, return_char_alignments=True)
        aligned_segments = aligned.get("segments", [])
        result_words: list[list[int | float]] = []
        aligned_token_weight = 0.0
        token_index = 0
        # Which token ends each line, so a held note can be given the length it is held for.
        last_token_of_line: dict[int, int] = {}
        for line_index, count in enumerate(counts):
            # The aligner answers per segment, and a segment is a line. Re-cutting one flat word
            # list by token count instead assumed every line takes time in proportion to its
            # length, which is the guess this function exists to stop making.
            segment = aligned_segments[line_index] if line_index < len(aligned_segments) else {}
            # Every word of the line, in the order it is written — including the ones the
            # aligner could not place, which are given a spot between their neighbours.
            candidates = fill_unaligned(segment.get("words", []), line_windows[line_index][0] / 1000, line_windows[line_index][1] / 1000)
            if candidates:
                projected = interpolate_boundaries(candidates, count)
                for token_offset, word_start, word_end, score in projected:
                    result_words.append([token_index + int(token_offset), word_start, word_end, score])
                line_windows[line_index] = [
                    round(float(candidates[0]["start"]) * 1000),
                    round(float(candidates[-1]["end"]) * 1000),
                ]
                aligned_token_weight += count * min(len(candidates), count) / max(len(candidates), count)
            else:
                fallback = [word for word in fallback_words if token_index <= int(word[0]) < token_index + count]
                result_words.extend(fallback)
            token_index += count
            last_token_of_line[token_index - 1] = line_index
        snap_line_starts(result_words, line_windows, counts, line_start_witness_ms)
        extend_held_endings(result_words, line_windows, last_token_of_line, heard_words)
        widen_thin_words(result_words, line_windows, counts)
        coverage = aligned_token_weight / max(1, sum(counts))
        quality = measure(result_words, line_windows, coverage, duration_ms, anchored_by_asr, language, detected)
        return {"variant_id": variant["id"], "line_spans": line_windows, "word_spans": result_words, "quality": quality}
    except Exception as error:
        print(f"[forced_align] fallback error={type(error).__name__}", file=sys.stderr)
        quality = measure(fallback_words, line_windows, 0.0, duration_ms, False, str(variant.get("language", "und")).split("-")[0], detected)
        return {"variant_id": variant["id"], "line_spans": line_windows, "word_spans": fallback_words, "quality": quality}


def measure(words: list[list[int | float]], lines: list[list[int]], coverage: float, duration_ms: int, anchored: bool, language: str = "und", detected: str = "und") -> dict[str, float]:
    """
    What the alignment is actually worth.

    monotonicity, duration_match and language_match used to be the literal 1.0, so every
    candidate scored a perfect 1.000 and the quality gate could never fail — including the
    ones whose timings were a proportional guess. They are measured now.
    """
    ordered = 0
    for index in range(1, len(words)):
        if float(words[index][1]) >= float(words[index - 1][1]):
            ordered += 1
    monotonicity = ordered / max(1, len(words) - 1)
    covered = sum(max(0, int(span[1]) - int(span[0])) for span in lines)
    span_end = max((int(span[1]) for span in lines), default=0)
    reach = min(1.0, span_end / duration_ms) if duration_ms > 0 else 0.0
    # A line that lasts no time at all is the aligner failing to find the words, not a fast line.
    instant = sum(1 for span in lines if int(span[1]) - int(span[0]) < 300)
    plausible = 1.0 - instant / max(1, len(lines))
    return {
        "token_coverage": coverage,
        "language_match": 1.0 if language == "und" or detected == "und" or language == detected.split("-")[0] else 0.0,
        "monotonicity": monotonicity,
        "duration_match": reach,
        "line_plausibility": plausible,
        "asr_anchored": 1.0 if anchored else 0.0,
        "alignment_fallback": 1.0 - coverage,
        "vocal_density": min(1.0, covered / duration_ms) if duration_ms > 0 else 0.0,
    }


def diarize(vocals: Path, backend: str, minimum: int | None, maximum: int | None) -> list[list[int | float]]:
    token = os.getenv("HF_TOKEN")
    if not token:
        return []
    try:
        import torch
        from pyannote.audio import Pipeline
        with redirect_stdout(sys.stderr):
            pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-community-1", token=token)
            device = "cuda" if backend == "cuda" else "mps" if backend == "mps" else "cpu"
            pipeline.to(torch.device(device))
            kwargs: dict[str, int] = {}
            if minimum is not None: kwargs["min_speakers"] = minimum
            if maximum is not None: kwargs["max_speakers"] = maximum
            output = pipeline(str(vocals), **kwargs)
        labels: dict[str, int] = {}
        turns: list[list[int | float]] = []
        for turn, speaker in output.speaker_diarization:
            speaker_id = labels.setdefault(str(speaker), len(labels))
            turns.append([speaker_id, round(turn.start * 1000), round(turn.end * 1000), 0.8])
        return turns
    except Exception:
        return []


def assign_speakers(variants: list[dict[str, Any]], turns: list[list[int | float]]) -> tuple[list[list[Any]], list[list[Any]]]:
    words: list[list[Any]] = []
    lines: list[list[Any]] = []
    for variant in variants:
        for token, start, end, _score in variant["word_spans"]:
            duration = max(1, end - start)
            for speaker, turn_start, turn_end, confidence in turns:
                overlap = max(0, min(end, turn_end) - max(start, turn_start))
                if overlap / duration >= 0.2:
                    words.append([variant["variant_id"], token, speaker, round(float(confidence) * overlap / duration, 4)])
        for index, (start, end) in enumerate(variant["line_spans"]):
            duration = max(1, end - start)
            for speaker, turn_start, turn_end, confidence in turns:
                overlap = max(0, min(end, turn_end) - max(start, turn_start))
                if overlap / duration >= 0.1:
                    lines.append([variant["variant_id"], index, speaker, round(float(confidence) * overlap / duration, 4)])
    return words, lines


def speaker_stems(vocals: Path, turns: list[list[int | float]], directory: Path) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []
    for speaker in sorted({int(turn[0]) for turn in turns}):
        ranges = [(float(start) / 1000, float(end) / 1000) for owner, start, end, _confidence in turns if int(owner) == speaker]
        expression = "+".join(f"between(t,{start:.3f},{end:.3f})" for start, end in ranges) or "0"
        output = directory / f"speaker-{speaker}.m4a"
        run_command(["ffmpeg", "-y", "-i", str(vocals), "-af", f"volume='if(gt({expression},0),1,0)':eval=frame", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(output)], "SPEAKER_STEM_FAILED")
        artifacts.append({"kind": "speaker", "speaker_id": speaker, "path": str(output), "content_type": "audio/mp4"})
    return artifacts


def waveform(mixture: Path, directory: Path) -> Path:
    mono = directory / "waveform.wav"
    run_command(["ffmpeg", "-y", "-i", str(mixture), "-ac", "1", "-ar", "8000", "-c:a", "pcm_s16le", str(mono)], "WAVEFORM_FAILED")
    with wave.open(str(mono), "rb") as stream:
        frames = stream.readframes(stream.getnframes())
    samples = [int.from_bytes(frames[index:index + 2], "little", signed=True) for index in range(0, len(frames), 2)]
    bucket = max(1, len(samples) // 2000)
    peaks = [max(abs(value) for value in samples[index:index + bucket]) / 32768 for index in range(0, len(samples), bucket)]
    output = directory / "waveform.json"
    output.write_text(json.dumps(peaks, separators=(",", ":")), encoding="utf-8")
    mono.unlink(missing_ok=True)
    return output


def run_job(params: dict[str, Any]) -> dict[str, Any]:
    config = self_test()
    if not config["production_ready"]:
        raise RuntimeError("WORKER_NOT_PRODUCTION_READY")
    job = params["job"]
    # The caller owns the directory so a retry can reuse whatever the last attempt finished.
    requested = params.get("work_dir")
    if requested:
        directory = Path(requested)
        directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    else:
        directory = Path(tempfile.mkdtemp(prefix=f"mora-{job['job_id']}-", dir=params.get("work_root")))
    notify("probe", "started", 0.01)
    notify("download", "started", 0.03)
    source = downloaded(directory) or download(job, directory, params.get("cookie_file"))
    notify("download", "completed", 0.1)
    metadata = probe(source)
    duration_ms = round(float(metadata.get("format", {}).get("duration", 0)) * 1000)
    if duration_ms <= 0 or duration_ms > int(job["source"]["max_duration_ms"]):
        raise RuntimeError("DURATION_REJECTED")
    notify("transcode", "started", 0.12)
    mixture = directory / "mixture.wav"
    if not mixture.exists():
        mixture = transcode(source, directory)
    notify("transcode", "completed", 0.18)
    notify("separate", "started", 0.2)
    stems = separate(mixture, directory, config["backend"])
    notify("separate", "completed", 0.52)
    notify("coarse_asr", "started", 0.55)
    asr, detected = coarse_asr(stems["vocals"], job["recording"].get("language", "und"), config["backend"])
    notify("coarse_asr", "completed", 0.64)
    notify("language_validate", "started", 0.65)
    validate_language(detected, str(job["recording"].get("language", "und")))
    notify("forced_align", "started", 0.66)
    variants = [align_variant(stems["vocals"], variant, asr, duration_ms, config["backend"], detected) for variant in job["lyrics"]]
    notify("forced_align", "completed", 0.8)
    notify("diarize", "started", 0.81)
    turns = diarize(stems["vocals"], config["backend"], job["pipeline"].get("min_speakers"), job["pipeline"].get("max_speakers"))
    word_speakers, line_speakers = assign_speakers(variants, turns)
    notify("diarize", "completed", 0.88)
    notify("speaker_stems", "started", 0.89)
    speaker_artifacts = speaker_stems(stems["vocals"], turns, directory) if turns else []
    review_source = directory / "source.m4a"
    run_command(["ffmpeg", "-y", "-i", str(mixture), "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(review_source)], "SOURCE_REVIEW_ENCODE_FAILED")
    artifacts: list[dict[str, Any]] = [{"kind": "source", "path": str(review_source), "content_type": "audio/mp4"}]
    for name, path in stems.items():
        encoded = directory / f"{name}.m4a"
        run_command(["ffmpeg", "-y", "-i", str(path), "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(encoded)], "STEM_ENCODE_FAILED")
        artifacts.append({"kind": name if name in ("vocals", "drums", "bass", "other") else "other", "path": str(encoded), "content_type": "audio/mp4"})
    artifacts.extend(speaker_artifacts)
    notify("speaker_stems", "completed", 0.92)
    notify("index", "started", 0.93)
    artifacts.append({"kind": "waveform", "path": str(waveform(mixture, directory)), "content_type": "application/json"})
    checkpoint = directory / "checkpoint.json"
    checkpoint.write_text(json.dumps({"pipeline": job["pipeline"], "detected": detected, "variants": variants}, separators=(",", ":")), encoding="utf-8")
    artifacts.append({"kind": "checkpoint", "path": str(checkpoint), "content_type": "application/json"})
    notify("index", "completed", 0.95)
    notify("quality_gate", "completed", 0.96)
    expected_language = str(job["recording"].get("language", "und"))
    average = lambda key: sum(float(item["quality"].get(key, 0.0)) for item in variants) / max(1, len(variants))
    quality = {
        "token_coverage": average("token_coverage"),
        "monotonicity": average("monotonicity"),
        "line_plausibility": average("line_plausibility"),
        "asr_anchored": average("asr_anchored"),
        "duration_match": max(0.0, 1 - abs(duration_ms - int(job["recording"]["duration_ms"])) / 10000),
        "language_match": 1.0 if expected_language == "und" or detected.split("-")[0] == expected_language.split("-")[0] else 0.0,
    }
    return {"backend": config["backend"], "hardware": config["hardware"], "detected_languages": [detected], "variants": variants, "speaker_turns": turns, "word_speakers": word_speakers, "line_speakers": line_speakers, "artifacts": artifacts, "quality": quality, "work_dir": str(directory)}


def respond(identifier: Any, result: Any = None, error: Exception | None = None) -> None:
    if error is None:
        payload = {"jsonrpc": "2.0", "id": identifier, "result": result}
    else:
        code = str(error) if str(error).isupper() and " " not in str(error) else "ML_PIPELINE_FAILED"
        payload = {"jsonrpc": "2.0", "id": identifier, "error": {"code": code, "message": code}}
        traceback.print_exc(file=sys.stderr)
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> None:
    for line in sys.stdin:
        try:
            request = json.loads(line)
            method = request.get("method")
            if method == "self_test":
                respond(request.get("id"), self_test())
            elif method == "run_job":
                respond(request.get("id"), run_job(request.get("params") or {}))
            else:
                raise RuntimeError("METHOD_NOT_FOUND")
        except Exception as error:
            respond(request.get("id") if isinstance(request, dict) else None, error=error)


if __name__ == "__main__":
    main()
