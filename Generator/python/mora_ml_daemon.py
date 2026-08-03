#!/usr/bin/env python3
"""Long-running JSON-RPC ML daemon. Stdout is protocol-only; logs go to stderr."""
from __future__ import annotations

import importlib.util
from contextlib import redirect_stdout
import json
import math
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import traceback
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
            candidates = [path for path in directory.glob("source.*") if path.suffix != ".part"]
            if candidates:
                return candidates[0]
    raise RuntimeError("YTDLP_FAILED")


def transcode(source: Path, directory: Path) -> Path:
    output = directory / "mixture.wav"
    run_command(["ffmpeg", "-y", "-i", str(source), "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s24le", str(output)], "TRANSCODE_FAILED")
    return output


def separate(mixture: Path, directory: Path, backend: str) -> dict[str, Path]:
    output = directory / "demucs"
    device = "mps" if backend == "mps" else "cuda" if backend == "cuda" else "cpu"
    run_command([sys.executable, "-m", "demucs", "-n", "htdemucs_ft", "--device", device, "--out", str(output), str(mixture)], "SEPARATION_FAILED")
    stem_dir = output / "htdemucs_ft" / mixture.stem
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


def align_variant(vocals: Path, variant: dict[str, Any], asr: dict[str, Any], duration_ms: int, backend: str) -> dict[str, Any]:
    text_lines = [line for line in str(variant["text"]).splitlines() if line.strip()]
    counts = [int(value) for value in variant.get("token_counts", [])]
    if len(counts) != len(text_lines):
        counts = [max(1, len(line.split())) for line in text_lines]
    start, end = audio_bounds(asr, duration_ms)
    line_windows, fallback_words = proportional_spans(counts, start, end)
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
        all_candidates = sorted(
            [word for word in aligned.get("word_segments", []) if "start" in word and "end" in word],
            key=lambda word: float(word["start"]),
        )
        if not all_candidates:
            all_candidates = sorted(
                [word for segment in aligned_segments for word in segment.get("words", []) if "start" in word and "end" in word],
                key=lambda word: float(word["start"]),
            )
        result_words: list[list[int | float]] = []
        aligned_token_weight = 0.0
        token_index = 0
        candidate_index = 0
        cumulative_tokens = 0
        total_tokens = sum(counts)
        for line_index, count in enumerate(counts):
            cumulative_tokens += count
            next_candidate_index = len(all_candidates) if line_index == len(counts) - 1 else round(cumulative_tokens * len(all_candidates) / max(1, total_tokens))
            candidates = all_candidates[candidate_index:next_candidate_index]
            candidate_index = next_candidate_index
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
        coverage = aligned_token_weight / max(1, sum(counts))
        return {"variant_id": variant["id"], "line_spans": line_windows, "word_spans": result_words, "quality": {"token_coverage": coverage, "monotonicity": 1.0, "duration_match": 1.0, "language_match": 1.0, "alignment_fallback": 1.0 - coverage}}
    except Exception as error:
        print(f"[forced_align] fallback error={type(error).__name__}", file=sys.stderr)
        return {"variant_id": variant["id"], "line_spans": line_windows, "word_spans": fallback_words, "quality": {"token_coverage": 0.0, "monotonicity": 1.0, "duration_match": 1.0, "language_match": 1.0, "alignment_fallback": 1.0}}


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
    work_root = params.get("work_root")
    directory = Path(tempfile.mkdtemp(prefix=f"mora-{job['job_id']}-", dir=work_root))
    notify("probe", "started", 0.01)
    notify("download", "started", 0.03)
    source = download(job, directory, params.get("cookie_file"))
    notify("download", "completed", 0.1)
    metadata = probe(source)
    duration_ms = round(float(metadata.get("format", {}).get("duration", 0)) * 1000)
    if duration_ms <= 0 or duration_ms > int(job["source"]["max_duration_ms"]):
        raise RuntimeError("DURATION_REJECTED")
    notify("transcode", "started", 0.12)
    mixture = transcode(source, directory)
    notify("transcode", "completed", 0.18)
    notify("separate", "started", 0.2)
    stems = separate(mixture, directory, config["backend"])
    notify("separate", "completed", 0.52)
    notify("coarse_asr", "started", 0.55)
    asr, detected = coarse_asr(stems["vocals"], job["recording"].get("language", "und"), config["backend"])
    notify("coarse_asr", "completed", 0.64)
    notify("forced_align", "started", 0.66)
    variants = [align_variant(stems["vocals"], variant, asr, duration_ms, config["backend"]) for variant in job["lyrics"]]
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
    artifacts.append({"kind": "waveform", "path": str(waveform(mixture, directory)), "content_type": "application/json"})
    checkpoint = directory / "checkpoint.json"
    checkpoint.write_text(json.dumps({"pipeline": job["pipeline"], "detected": detected, "variants": variants}, separators=(",", ":")), encoding="utf-8")
    artifacts.append({"kind": "checkpoint", "path": str(checkpoint), "content_type": "application/json"})
    notify("quality_gate", "completed", 0.96)
    quality = {"token_coverage": sum(item["quality"]["token_coverage"] for item in variants) / max(1, len(variants)), "monotonicity": 1.0, "duration_match": max(0.0, 1 - abs(duration_ms - int(job["recording"]["duration_ms"])) / 10000), "language_match": 1.0 if detected.split("-")[0] == str(job["recording"].get("language", "und")).split("-")[0] or job["recording"].get("language") == "und" else 0.0}
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
