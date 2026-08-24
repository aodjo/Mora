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
import statistics
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


# 가속기를 못 찾은 이유. "cpu" 라는 답만 들고는 무엇을 고쳐야 할지 알 수 없다.
backend_fallback: dict[str, str] = {}


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
        backend_fallback["reason"] = f"torch {torch.__version__} 에 쓸 수 있는 가속기가 없습니다"
    except Exception as error:
        backend_fallback["reason"] = f"torch 를 불러오지 못했습니다 — {type(error).__name__}: {error}"
    return "cpu", hardware


def self_test() -> dict[str, Any]:
    backend, hardware = detect_backend()
    checks = {
        "yt-dlp": "passed" if command_exists("yt-dlp") else "failed",
        "ffmpeg": "passed" if command_exists("ffmpeg") and command_exists("ffprobe") else "failed",
        "htdemucs_ft": "passed" if module_exists("demucs") else "failed",
        "coarse_asr": "passed" if (backend == "mps" and module_exists("mlx_whisper")) or module_exists("whisperx") else "failed",
        "forced_align": "passed" if module_exists("whisperx") else "failed",
        "split_voices": "passed" if module_exists("audio_separator") else "skipped",
        "mixed_script": "passed" if module_exists("torchaudio") and module_exists("uroman") else "skipped",
        "diarization": "passed" if module_exists("pyannote.audio") and bool(os.getenv("HF_TOKEN")) else "skipped",
    }
    required = ("yt-dlp", "ffmpeg", "htdemucs_ft", "coarse_asr", "forced_align")
    report: dict[str, Any] = {
        "backend": backend,
        "hardware": hardware,
        "checks": checks,
        "production_ready": backend != "cpu" and all(checks[key] == "passed" for key in required),
    }
    if backend == "cpu" and "reason" in backend_fallback:
        report["backend_reason"] = backend_fallback["reason"]
    return report


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
    """
    The audio, from the first source that gives it up.

    YouTube signs its media URLs with a challenge that has to be run as JavaScript. yt-dlp only
    looks for deno by default, and without a runtime it falls back to a client whose URLs come
    back 403 Forbidden. Node is always here — the worker that calls this daemon is a Node
    program — so it is offered as a runtime rather than left unfound.
    """
    urls = [job["source"]["url"], *job["source"].get("alternatives", [])]
    refused: list[str] = []
    for url in urls:
        output = directory / "source.%(ext)s"
        args = ["yt-dlp", "--no-playlist", "--no-write-info-json", "--js-runtimes", "node", "-f", "bestaudio/best", "-o", str(output)]
        if cookie_file:
            args += ["--cookies", cookie_file]
        args.append(url)
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if result.returncode == 0:
            existing = downloaded(directory)
            if existing is not None:
                return existing
        # yt-dlp 가 왜 안 됐는지 말했는데 그것을 버리면, 남는 것은 "안 됐다" 뿐이다.
        said = [line for line in result.stderr.splitlines() if line.strip()]
        refused.append(f"{url}: {said[-1] if said else f'exit {result.returncode}'}")
    error = RuntimeError("YTDLP_FAILED")
    error.detail = "\n".join(refused)  # type: ignore[attr-defined]
    print(f"[download] {error.detail}", file=sys.stderr)
    raise error


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


KARAOKE_MODEL = "mel_band_roformer_karaoke_gabox_v2.ckpt"


def model_cache() -> str:
    root = os.getenv("MORA_CACHE_ROOT") or str(Path.home() / "Library/Caches/Mora")
    directory = Path(root) / "audio-separator"
    directory.mkdir(parents=True, exist_ok=True)
    return str(directory)


separator_cache: dict[str, Any] = {}


def loaded_separator() -> Any:
    if "separator" not in separator_cache:
        from audio_separator.separator import Separator

        separator = Separator(output_format="WAV", model_file_dir=model_cache(), log_level=40)
        separator.load_model(KARAOKE_MODEL)
        separator_cache["separator"] = separator
    return separator_cache["separator"]


def split_voices(vocals: Path, directory: Path, backend: str) -> tuple[Path, Path] | None:
    """
    The lead voice and the one singing over it, as two files.

    Demucs returns one vocal stem with every voice mixed into it, so a line shouted over another
    — "(꺼져)" over "그래도 제발 나를 사랑해줄래?" — reaches the transcriber as one signal and
    only the louder voice is written down. Measured on that song: the transcriber's words ran
    unbroken from 97.3s to 103.3s with not one syllable of either aside in them.

    The second voice cannot be read even once it is on its own — separated, it transcribes as
    "아 아 아". It can be *heard*, and that is all the timing needs: on the same song the split
    put four times more energy where the asides are than where the lead sings alone, and near
    silence in the interlude.
    """
    lead = directory / "lead.wav"
    backing = directory / "backing.wav"
    if lead.exists() and backing.exists():
        return lead, backing
    if not module_exists("audio_separator"):
        return None
    try:
        with redirect_stdout(sys.stderr):
            # 모델을 올리는 데만 40초가 든다. 데몬은 계속 살아 있으니 한 번만 올린다. 대신
            # 결과가 나갈 자리는 작업마다 다르므로, 이미 만들어진 모델에게도 알려 준다.
            separator = loaded_separator()
            separator.output_dir = str(directory)
            separator.model_instance.output_dir = str(directory)
            produced = separator.separate(str(vocals))
    except Exception as error:
        print(f"[split_voices] skipped error={type(error).__name__}: {error}", file=sys.stderr)
        return None
    # 이 모델은 리드를 "Vocals", 나머지 목소리를 "Instrumental" 로 이름 붙인다.
    written = {("lead" if "(Vocals)" in name else "backing"): directory / name for name in produced}
    if "lead" not in written or "backing" not in written:
        return None
    written["lead"].replace(lead)
    written["backing"].replace(backing)
    return lead, backing


def envelope(path: Path, hz: int = 100) -> Any:
    """Loudness of the file, one number per 1/hz of a second."""
    import numpy
    import soundfile
    samples, rate = soundfile.read(str(path), always_2d=True)
    mono = samples.mean(axis=1)
    hop = max(1, rate // hz)
    frames = len(mono) // hop
    return numpy.sqrt(numpy.array([numpy.mean(mono[index * hop : (index + 1) * hop] ** 2) for index in range(frames)]) + 1e-12)


def second_voice_regions(lead: Path, backing: Path, hz: int = 100) -> list[tuple[float, float]]:
    """
    When someone other than the lead is singing.

    Judged against the lead rather than against an absolute level, because a quiet song and a
    loud one differ by more than a backing voice does. On the measured song the ratio was 0.32
    where the asides are, 0.08 where the lead sings alone and 0.015 in the interlude.
    """
    try:
        import numpy
        back, front = envelope(backing, hz), envelope(lead, hz)
    except Exception as error:
        # 두 번째 목소리를 못 재는 것은 작업을 세울 이유가 아니다 — 못 들었다고 답한다.
        print(f"[second_voice] unavailable error={type(error).__name__}: {error}", file=sys.stderr)
        return []
    frames = min(len(back), len(front))
    if frames == 0:
        return []
    back, front = back[:frames], front[:frames]
    loudest = float(numpy.percentile(front, 99))
    if loudest <= 0:
        return []
    floor = loudest * 0.05
    active = (back / numpy.maximum(front, floor) > 0.30) & (back > floor)
    regions: list[tuple[float, float]] = []
    start: int | None = None
    quiet = 0
    for index in range(frames):
        if active[index]:
            if start is None:
                start = index
            quiet = 0
            continue
        if start is None:
            continue
        quiet += 1
        # 200ms 넘게 조용하면 한 번 부른 것이 끝난 것으로 본다.
        if quiet > hz // 5:
            regions.append((start / hz, (index - quiet) / hz))
            start = None
    if start is not None:
        regions.append((start / hz, frames / hz))
    return [(begin, end) for begin, end in regions if end - begin >= 0.2]


def expected_language(job: dict[str, Any]) -> str:
    """
    The language the transcriber should listen in.

    Left to itself Whisper decides from the opening seconds, and a track that opens with a
    Japanese skit before a Korean song is then transcribed as Japanese end to end — on the
    measured track it produced じゃ five hundred times and not one word of the lyrics. We are
    not guessing: the lyric sheets name their language. When the recording does not say, the
    lyrics do.
    """
    recorded = str(job["recording"].get("language", "und")).split("-")[0]
    if recorded != "und":
        return recorded
    votes: dict[str, int] = {}
    for variant in job.get("lyrics", []):
        code = str(variant.get("language", "und")).split("-")[0]
        if code != "und":
            votes[code] = votes.get(code, 0) + 1
    return max(votes, key=lambda code: votes[code]) if votes else "und"


def coarse_asr(vocals: Path, language: str, backend: str) -> tuple[dict[str, Any], str]:
    if backend == "mps":
        import mlx_whisper
        # turbo 는 디코더를 32층에서 4층으로 줄여 몇 배 빠르지만, 그만큼 흘린다 — 특히 한국어의
        # 조사와 짧은 단어를. 여기서 받아쓰기는 가사가 아니라 "그 말이 몇 초에 나왔나"를 대는
        # 증인이므로, 흘린 단어는 곧 앵커가 없는 줄이고 그것이 정렬을 무너뜨린다.
        model = os.getenv("MORA_MLX_WHISPER_MODEL", "mlx-community/whisper-large-v3-mlx")
        with redirect_stdout(sys.stderr):
            # condition_on_previous_text 가 켜져 있으면 한 번 삐끗한 뒤 같은 말을 되풀이한다 —
            # 실측에서 じゃ 를 오백 번 받아썼다. 각 구간을 제 소리로만 듣게 한다.
            result = mlx_whisper.transcribe(
                str(vocals),
                path_or_hf_repo=model,
                word_timestamps=True,
                condition_on_previous_text=False,
                language=None if language == "und" else language.split("-")[0],
            )
        return result, str(result.get("language", language))
    import whisperx
    device = "cuda" if backend == "cuda" else backend
    compute_type = "float16" if backend in ("cuda", "xpu", "rocm") else "int8"
    with redirect_stdout(sys.stderr):
        model = whisperx.load_model(
            os.getenv("MORA_WHISPER_MODEL", "large-v3"),
            device,
            compute_type=compute_type,
            language=None if language == "und" else language.split("-")[0],
        )
        audio = whisperx.load_audio(str(vocals))
        result = model.transcribe(audio, batch_size=8)
    return result, str(result.get("language", language))


def written_language(text: str, declared: str) -> str:
    """
    The alphabet the lyric is actually written in, whichever one it is filed under.

    The forced aligner is chosen by this, and it is a phoneme model with a fixed alphabet: the
    Korean one holds Hangul and not one Latin letter. DPR LIVE's "Jasmine" is 84% English and
    was filed as Korean — the lyric came from a Korean service and the recording did not say —
    so every English word in it was handed to a model that cannot spell it, and 345 of its 413
    words were aligned by wildcard. What a sheet is labelled is a guess about the song; what it
    is written in is a fact about the sheet, and it is the one the aligner needs.

    Only a clear majority overrules the label, and only for a language the aligner has a model
    for; a truly mixed sheet keeps what it was given, and the minority script is borrowed from
    the multilingual aligner word by word.
    """
    hangul = sum(1 for character in text if "가" <= character <= "힣")
    latin = sum(1 for character in text if character.isascii() and character.isalpha())
    total = hangul + latin
    if total < 20:
        return declared
    supported = alignable_languages()
    for share, code in ((hangul / total, "ko"), (latin / total, "en")):
        if share >= 0.7 and code != declared and (supported is None or code in supported):
            return code
    return declared


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


def audio_bounds(asr: dict[str, Any], duration_ms: int, lyric_words: list[str] | None = None) -> tuple[float, float]:
    """
    Where the words we are timing begin and end.

    Not simply where sound begins: a track can open with talking that is not in the lyric
    sheet, and starting there draws the first line across it. When we know what the lyrics say,
    the region starts at the first thing heard that the sheet also contains — spoken intros
    rarely repeat the words of the song. With nothing to compare against, the first sound is
    still the best guess available.
    """
    segments = asr.get("segments") or []
    if not segments:
        return 0.0, duration_ms / 1000.0
    first = max(0.0, float(segments[0].get("start", 0)))
    last = min(duration_ms / 1000.0, float(segments[-1].get("end", duration_ms / 1000.0)))
    if not lyric_words:
        return first, last
    wanted = set(lyric_words)
    for word in asr_words(asr):
        if word["text"] in wanted:
            return max(first, min(float(word["start"]), last)), last
    return first, last


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


# 받아쓰기가 조용한 데를 만나면 자막 데이터에서 배운 상투구로 채운다. 어느 노래의 가사도
# 아니다. Ruru "살인 아니고 사랑인데요??" 는 노래가 시작하기 전 17초를 이것으로 덮었다.
INVENTED_PHRASES = (
    "한국어자막을사용하였습니다",
    "한국어자막",
    "자막제공",
    "배달의민족",
    "시청자여러분",
    "자막by",
    "시청해주셔서감사합니다",
    "구독과좋아요부탁드립니다",
    "다음영상에서만나요",
    "thanksforwatching",
    "thankyouforwatching",
    "subtitlesby",
    "pleasesubscribe",
    "ご視聴ありがとうございました",
    "字幕by",
)


def bare(value: str) -> str:
    """The text with everything that is not a letter or a digit taken out."""
    return re.sub(r"[\W_]+", "", value.lower(), flags=re.UNICODE)


def invented_segment(text: str, sheet: str) -> bool:
    """True when this is the transcriber filling silence with what subtitle files say."""
    written = bare(text)
    if not written or written in sheet:
        return False
    # 상투구는 후원사 이름 같은 것을 달고 늘어난다: "자막 제공 배달의민족". 절반을 채워야
    # 한다고 하면 그런 것을 놓친다. 가사지에 없다는 조건이 함부로 지우는 것을 막는다.
    return any(phrase in written and len(phrase) * 3 >= len(written) for phrase in INVENTED_PHRASES)


def listen_again(vocals: Path, begin: float, finish: float, backend: str) -> dict[str, Any] | None:
    """Transcribe one stretch on its own, letting the transcriber pick the language itself."""
    try:
        import soundfile

        samples, rate = soundfile.read(str(vocals), always_2d=True)
        first = max(0, int((begin - 0.5) * rate))
        last = min(len(samples), int((finish + 0.5) * rate))
        if last - first < rate // 2:
            return None
        with tempfile.TemporaryDirectory() as scratch:
            clip = Path(scratch) / "again.wav"
            soundfile.write(str(clip), samples[first:last], rate)
            heard, _ = coarse_asr(clip, "und", backend)
        offset = first / rate
        for segment in heard.get("segments") or []:
            segment["start"] = float(segment.get("start", 0)) + offset
            segment["end"] = float(segment.get("end", 0)) + offset
            for word in segment.get("words") or []:
                if "start" in word:
                    word["start"] = float(word["start"]) + offset
                if "end" in word:
                    word["end"] = float(word["end"]) + offset
        return heard
    except Exception as error:
        print(f"[asr] second listen failed error={type(error).__name__}: {error}", file=sys.stderr)
        return None


def redo_invented_segments(asr: dict[str, Any], lyric_text: str, vocals: Path, backend: str) -> dict[str, Any]:
    """
    Listen again wherever the transcriber wrote what subtitle files say instead of what was sung.

    Whisper learned from subtitle files, so it answers with their boilerplate — but not only over
    silence. On DPR LIVE's "Jasmine" it gave 16.7 seconds of loud, plainly sung English chorus,
    at four fifths of the song's peak level, as the single line "자막 제공 배달의민족", and the
    eight lyric lines sung there were left without a witness. The cause is the language: the
    sheet was filed as Korean, so Korean was forced on an English song. Handed that same stretch
    on its own and allowed to choose, the transcriber returns "You know I can paint the world /
    Sitting there in black and gold / …" — every line of it.

    So a stretch like that is not deleted, it is asked again. Only if the second answer is more
    boilerplate is it dropped, because then there is nothing there to hear.
    """
    segments = asr.get("segments") or []
    if not segments:
        return asr
    sheet = bare(lyric_text)
    kept: list[dict[str, Any]] = []
    changed = False
    for segment in segments:
        if not invented_segment(str(segment.get("text", "")), sheet):
            kept.append(segment)
            continue
        changed = True
        begin, finish = float(segment.get("start", 0)), float(segment.get("end", 0))
        again = listen_again(vocals, begin, finish, backend)
        recovered = [part for part in ((again or {}).get("segments") or []) if not invented_segment(str(part.get("text", "")), sheet)]
        if recovered:
            print(f"[asr] listened again to {begin:.1f}-{finish:.1f}s: {len(recovered)} line(s) recovered", file=sys.stderr)
            kept.extend(recovered)
        else:
            print(f"[asr] dropped invented segment {begin:.1f}-{finish:.1f}s: {str(segment.get('text', '')).strip()!r}", file=sys.stderr)
    if not changed:
        return asr
    kept.sort(key=lambda part: float(part.get("start", 0)))
    return {**asr, "segments": kept}


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
    Needleman-Wunsch, keeping only the pairs that matched. The gaps between those anchors are
    what interpolation is for.

    It runs over characters rather than whole words, because whole words are not what the two
    sides disagree about in Korean. A lyric sheet writes 도시속에 where the transcriber writes
    도시 속에, and 너 하나 where it writes 너하나 — the sounds are identical and every word of
    the line fails to match. Characters do not care where the spaces went: the run 도시속에
    lines up either way, and the word it belongs to is looked up afterwards.
    """
    if not lyric or not heard:
        return {}
    # 글자 흐름과, 각 글자가 어느 단어에서 왔는지.
    lyric_chars: list[str] = []
    lyric_owner: list[int] = []
    for index, word in enumerate(lyric):
        for character in word:
            lyric_chars.append(character)
            lyric_owner.append(index)
    heard_chars: list[str] = []
    heard_owner: list[int] = []
    for index, word in enumerate(heard):
        for character in str(word["text"]):
            heard_chars.append(character)
            heard_owner.append(index)
    if not lyric_chars or not heard_chars:
        return {}
    # 아주 긴 가사에서는 글자 표가 커진다. 그럴 때만 단어 단위로 물러난다.
    if len(lyric_chars) * len(heard_chars) > 6_000_000:
        return match_tokens(lyric, heard)
    pairs = align_streams(lyric_chars, heard_chars)
    anchors: dict[int, dict[str, Any]] = {}
    matched_chars: dict[int, int] = {}
    for lyric_index, heard_index in pairs:
        word = lyric_owner[lyric_index]
        matched_chars[word] = matched_chars.get(word, 0) + 1
        if word not in anchors:
            anchors[word] = heard[heard_owner[heard_index]]
    # 한두 글자가 우연히 겹친 것은 앵커가 아니다. 단어의 절반은 맞아야 그 단어를 봤다고 한다.
    # 두 글자짜리에는 절반이 너무 헐겁다: 받아쓰기가 인트로에 지어낸 "한국어" 에 가사의 "싶어"
    # 가 '어' 하나로 붙어, 그 줄이 노래가 시작하기도 전으로 끌려간 적이 있다. 한 글자 낱말만
    # 제 한 글자로 족하고, 그보다 길면 최소 두 글자는 맞아야 한다.
    return {
        index: word
        for index, word in anchors.items()
        if matched_chars[index] >= needed_characters(lyric[index])
    }


def needed_characters(word: str) -> int:
    """How much of a written word must be heard before we say we heard it."""
    return 1 if len(word) <= 1 else max(2, (len(word) + 1) // 2)


def align_streams(left: list[str], right: list[str]) -> list[tuple[int, int]]:
    """Needleman-Wunsch over two character streams, returning only the positions that matched."""
    rows, columns = len(left), len(right)
    scores = [[0.0] * (columns + 1) for _ in range(rows + 1)]
    for row in range(1, rows + 1):
        scores[row][0] = -row
    for column in range(1, columns + 1):
        scores[0][column] = -column
    for row in range(1, rows + 1):
        character = left[row - 1]
        previous = scores[row - 1]
        current = scores[row]
        for column in range(1, columns + 1):
            diagonal = previous[column - 1] + (2.0 if character == right[column - 1] else -1.0)
            current[column] = max(diagonal, previous[column] - 1.0, current[column - 1] - 1.0)
    pairs: list[tuple[int, int]] = []
    row, column = rows, columns
    while row > 0 and column > 0:
        same = left[row - 1] == right[column - 1]
        if scores[row][column] == scores[row - 1][column - 1] + (2.0 if same else -1.0):
            if same:
                pairs.append((row - 1, column - 1))
            row -= 1
            column -= 1
        elif scores[row][column] == scores[row - 1][column] - 1.0:
            row -= 1
        else:
            column -= 1
    pairs.reverse()
    return pairs


def match_tokens(lyric: list[str], heard: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    """Whole-word matching, for lyrics too long to align character by character."""
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


BRACKETS = {"(": ")", "[": "]", "{": "}", "（": "）", "［": "］"}


def bracket_mask(line: str) -> list[bool]:
    """
    Which written words of the line are a bracketed aside — the second voice.

    "(꺼져)", "(나 너 싫으니까 꺼지라고)" are sung over the words beside them, not after them.
    Counted as ordinary words they are given a stretch of the song of their own, and the
    stretch comes out of their neighbours: on the measured song the aside took 1.3 seconds
    at the end of its line, the six words it was shouted over were squeezed into the 0.9
    before it, and the next line was pushed half a second late.

    A word is inside when the brackets around it are open, whether they opened on this word
    or an earlier one. Brackets holding no letters are punctuation, not a voice.
    """
    mask: list[bool] = []
    depth = 0
    for word in line.split():
        inside = depth > 0
        for character in word:
            if character in BRACKETS:
                depth += 1
                inside = True
            elif character in BRACKETS.values() and depth > 0:
                depth -= 1
        mask.append(inside and re.search(r"[^\W_]", word, re.UNICODE) is not None)
    return mask


def is_backing_line(line: str) -> bool:
    """A line that is nothing but a bracketed aside, so it has no voice of its own to time."""
    mask = bracket_mask(line)
    return len(mask) > 0 and all(mask)


def anchored_windows(
    counts: list[int],
    words: list[str],
    heard: list[dict[str, Any]],
    start: float,
    end: float,
    floor: float | None = None,
    backing: list[bool] | None = None,
) -> list[list[int]] | None:
    """
    A time window per lyric line, taken from where those words were actually sung.

    Dividing the vocal region by word count assumes a song spends equal time on equal words,
    which no song does — it has an intro, a bridge, a held note, a repeated chorus. Feeding
    those guesses to the forced aligner then pins each line inside the wrong seconds of audio,
    and the aligner cannot escape the window it was given. Returns None when too little of the
    lyric was recognised to place anything, leaving the proportional guess as the fallback.
    """
    # 백보컬 단어는 자리를 차지하지 않는다 — 옆에서 함께 부르지, 뒤이어 부르지 않는다. 시간을
    # 나눌 때 아예 빼고 센다. 빼지 않으면 그 단어들 몫으로 벌어진 간격이 이웃의 시간이 되고,
    # 다음 줄까지 밀린다. 줄 전체가 백보컬이면 셀 것이 남지 않으므로 옆줄의 창을 그대로 쓴다.
    if backing is not None and any(backing):
        voiced = [word for index, word in enumerate(words) if index >= len(backing) or not backing[index]]
        voiced_counts: list[int] = []
        cursor = 0
        for count in counts:
            voiced_counts.append(sum(1 for offset in range(count) if cursor + offset >= len(backing) or not backing[cursor + offset]))
            cursor += count
        placed = anchored_windows(voiced_counts, voiced, heard, start, end, floor)
        if placed is None:
            return None
        # 부를 목소리가 없는 줄은 뒤따르는 진짜 줄과 같은 시간을 쓴다. 마지막이라면 앞줄과.
        for line_index in range(len(counts)):
            if voiced_counts[line_index] > 0:
                continue
            neighbour = next((i for i in range(line_index + 1, len(counts)) if voiced_counts[i] > 0), None)
            if neighbour is None:
                neighbour = next((i for i in range(line_index - 1, -1, -1) if voiced_counts[i] > 0), None)
            placed[line_index] = list(placed[neighbour]) if neighbour is not None else [round(start * 1000), round(end * 1000)]
        return placed

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
            # 첫 앵커보다 앞선 줄들. 한 단어당 0.35초씩 되짚어 가되, 소리가 시작하기 전으로는
            # 가지 않는다 — 바닥이 "가사가 처음 들린 곳"이면 이 줄들이 그 지점에 뭉개진다.
            reach = anchors[after[0]]["start"] - (after[0] - index) * 0.35
            positions.append(max(start if floor is None else floor, reach))
        else:
            return None
    for index in range(1, len(positions)):
        positions[index] = max(positions[index], positions[index - 1])
    windows: list[list[int]] = []
    cursor = 0
    for count in counts:
        if count <= 0:
            # 자리를 차지하지 않는 줄 — 부르는 쪽에서 이웃의 창을 넣어 준다.
            windows.append([round(start * 1000), round(start * 1000)])
            continue
        first = min(len(positions) - 1, cursor)
        last = min(len(positions) - 1, cursor + count - 1)
        line_start = positions[first]
        line_end = anchors[last]["end"] if last in anchors else positions[last] + 0.4
        if cursor + count < len(positions):
            line_end = min(max(line_end, line_start + 0.3), positions[cursor + count])
        # 하한은 되짚어 갈 수 있는 바닥이다. 시작점(가사가 처음 들린 곳)을 하한으로 쓰면
        # 그 앞에 놓인 줄이 시작보다 끝이 이른 창을 갖게 된다.
        opened = max(start if floor is None else floor, line_start)
        # 구간의 끝으로 자르되 시작보다 이르게 두지 않는다 — 마지막 줄이 끝을 넘겨 시작하면
        # 시작이 끝보다 늦은 창이 나오고, 그런 창 안에서는 정렬기가 아무것도 할 수 없다.
        closed = max(min(end, max(line_end, opened + 0.3)), opened + 0.3)
        windows.append([round(opened * 1000), round(closed * 1000)])
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
# 가장 빠른 랩이 초당 열 음절이다. 한 음절에 이보다 적은 시간이 배정됐다면 사람이 낼 수 없는 속도다.
MIN_SYLLABLE_MS = 100.0


def syllables(word: str) -> int:
    """대강의 음절 수. 시간을 나눌 몫을 정하는 데만 쓰므로 정확할 필요는 없고 공평하면 된다."""
    count = 0
    in_vowel_run = False
    for character in word:
        code = ord(character)
        if 0xAC00 <= code <= 0xD7A3 or 0x3040 <= code <= 0x30FF or 0x4E00 <= code <= 0x9FFF:
            count += 1  # 한글·가나·한자는 한 글자가 한 음절이다.
            in_vowel_run = False
        elif character.isdigit():
            count += 1
            in_vowel_run = False
        elif character.isalpha():
            # 라틴 문자는 모음 덩어리를 하나로 센다: "kawaii" 는 세 몫.
            vowel = character.lower() in "aeiouy"
            if vowel and not in_vowel_run:
                count += 1
            in_vowel_run = vowel
        else:
            in_vowel_run = False
    return max(1, count)


def token_weights(text_lines: list[str], counts: list[int]) -> list[float]:
    """토큰마다 몇 음절어치 시간을 받을 자격이 있는지. 토큰이 낱말이 아니면 다 같은 몫이다."""
    weights: list[float] = []
    for line_index, count in enumerate(counts):
        written = text_lines[line_index].split() if line_index < len(text_lines) else []
        if len(written) == count:
            weights.extend(float(syllables(word)) for word in written)
        else:
            weights.extend([1.0] * max(0, count))
    return weights


# 정렬기가 짚은 자리와 받아쓰기가 들은 자리가 이만큼 넘게 벌어지면, 그것은 정렬기의 미세한
# 판정이 아니라 줄이 통째로 밀린 것이다. 실측으로 고른 값이다: 250ms 로 잡으면 넉 줄에 한 줄을
# 옮기며 정밀도를 깎고, 600ms 로 잡으면 손대는 줄이 몇 개뿐인데 1초짜리 드리프트는 여전히
# 잡는다 — 심판과의 일치가 워프를 끈 것과 같아지고, 긴 어긋남에서는 그보다 낫다.
DRIFT_MS = 600.0


def snap_words_to_witness(words: list[list[int | float]], counts: list[int], witness: dict[int, float]) -> None:
    """
    Move a line that has drifted onto the seconds the transcriber heard it in — and no more.

    Both witnesses are wrong in different ways. The forced aligner reads phonemes frame by frame,
    so it is precise about where one word ends and the next begins; the transcriber's word times
    come from attention, not from phonemes, and are coarse. This used to re-cut every boundary
    in the line onto the transcriber's times, which threw the precise answer away to keep the
    coarse one. Measured against a third aligner that has seen neither — the multilingual one —
    doing that tripled the error: a 46ms median became 148ms, and the share of words within
    100ms fell from 64% to 36%.

    So the transcriber is used for what it is good at. It knows roughly *when* a line was sung,
    which the aligner can get badly wrong when its window is off; it does not know where inside
    the line each word starts. A line whose words sit consistently early or late by more than a
    the threshold is shifted bodily onto the heard times, keeping every boundary the aligner
    measured; a smaller disagreement is the aligner being more exact than the transcriber, and
    is left alone.
    """
    position = 0
    floor = float("-inf")
    for count in counts:
        indices = [index for index, word in enumerate(words) if position <= int(word[0]) < position + count]
        position += max(0, count)
        if not indices:
            continue
        line_start, line_end = float(words[indices[0]][1]), float(words[indices[-1]][2])
        offsets: list[float] = []
        spoken = 0
        for index in indices:
            heard = witness.get(int(words[index][0]))
            if heard is None:
                continue
            spoken += 1
            # 줄 밖을 가리키는 증언은 이 줄 것이 아니다 — 다른 절에서 같은 말을 듣기도 한다.
            if line_start - 2000 <= heard <= line_end + 2000:
                offsets.append(heard - float(words[index][1]))
        if len(offsets) < max(1, (spoken + 1) // 2):
            floor = line_end
            continue
        shift = statistics.median(offsets)
        if abs(shift) >= DRIFT_MS:
            # 앞줄 위로 물러나지는 않는다.
            shift = max(shift, floor - line_start)
            for index in indices:
                words[index][1] = round(float(words[index][1]) + shift)
                words[index][2] = round(float(words[index][2]) + shift)
        floor = float(words[indices[-1]][2])


def spread_in_window(window: list[int], token_index: int, count: int, weights: list[float]) -> list[list[int | float]]:
    """The words of a line laid out across its own window, by syllable, when nothing was heard."""
    share = sum(weight_of(weights, token_index + offset) for offset in range(count)) or float(count)
    span = max(0, window[1] - window[0])
    placed: list[list[int | float]] = []
    cursor = float(window[0])
    for offset in range(count):
        width = span * weight_of(weights, token_index + offset) / share
        start = round(cursor)
        cursor += width
        placed.append([token_index + offset, start, round(cursor), 0.2])
    return placed


def close_lines_over_words(words: list[list[int | float]], lines: list[list[int]], counts: list[int]) -> None:
    """
    A line lasts as long as its words last, and no longer.

    Every step up to here may move a word — the aligner, the witness, the redistribution — but
    the line's own span was only ever allowed to grow, so it kept whichever start the very first
    guess had given it. When the words then landed somewhere else, the line stretched to cover
    both: on the measured song the opening line was written 12.6s–32.4s, nineteen seconds for
    four words whose own spans occupied 30.0s–32.4s, and it swallowed the six lines after it.
    The words are the answer; the line is only their outline.
    """
    position = 0
    for line_index, count in enumerate(counts):
        held = [word for word in words if position <= int(word[0]) < position + count]
        position += max(0, count)
        if not held or line_index >= len(lines):
            continue
        lines[line_index] = [round(min(float(word[1]) for word in held)), round(max(float(word[2]) for word in held))]


def place_backing_runs(
    words: list[list[int | float]],
    counts: list[int],
    text_lines: list[str],
    weights: list[float],
    regions: list[tuple[float, float]],
) -> int:
    """
    Put a bracketed aside where the second voice was actually heard, not after the line.

    The forced aligner can only lay words out one after another, so an aside written beside a
    line takes a slot at its end even though it was sung on top of it. Where the split heard the
    second voice, that guess can be replaced by a measurement: on "…흉터를 남기는건데? (나 너
    싫으니까 꺼지라고)" the aligner put the aside at 102.2–103.3 while the second voice was
    singing from 101.5, over the top of 남기는건데.

    Only the aside moves. The lead's words are left exactly where they were, which is why the
    two now overlap — that is what the audio says happened. A line whose second voice was never
    heard keeps the aligner's guess.
    """
    moved = 0
    position = 0
    for line_index, count in enumerate(counts):
        indices = [index for index, word in enumerate(words) if position <= int(word[0]) < position + count]
        first_token = position
        position += max(0, count)
        line = text_lines[line_index] if line_index < len(text_lines) else ""
        mask = bracket_mask(line)
        if not indices or not any(mask) or all(mask) or len(mask) != count:
            continue
        line_start = float(words[indices[0]][1]) / 1000
        line_end = float(words[indices[-1]][2]) / 1000
        overlapping = [(begin, end) for begin, end in regions if begin < line_end and end > line_start]
        if not overlapping:
            continue
        heard_from = max(line_start, min(begin for begin, _ in overlapping))
        heard_to = min(line_end, max(end for _, end in overlapping))
        if heard_to - heard_from < 0.2:
            continue
        for run in bracket_runs(mask):
            in_run = [index for index in indices if int(words[index][0]) - first_token in run]
            if not in_run:
                continue
            share = sum(weight_of(weights, int(words[index][0])) for index in in_run)
            cursor = heard_from * 1000
            for index in in_run:
                width = (heard_to - heard_from) * 1000 * weight_of(weights, int(words[index][0])) / max(share, 1e-9)
                words[index][1] = round(cursor)
                cursor += width
                words[index][2] = round(cursor)
            moved += len(in_run)
    return moved


def bracket_runs(mask: list[bool]) -> list[set[int]]:
    """The maximal stretches of bracketed words, as sets of positions within the line."""
    runs: list[set[int]] = []
    current: set[int] = set()
    for position, flag in enumerate(mask):
        if flag:
            current.add(position)
        elif current:
            runs.append(current)
            current = set()
    if current:
        runs.append(current)
    return runs


def spread_crushed_words(words: list[list[int | float]], lines: list[list[int]], counts: list[int], weights: list[float]) -> None:
    """
    Give back the time a word lost to the word that ran over it, in proportion to what it sings.

    The forced aligner does not fail loudly. When it cannot find a phoneme it collapses the rest
    of the line onto the end of it: on the measured song "출근하는 아빠옆에 못 남아 난 도망쳐"
    came back with 1429ms on 아빠옆에 and the last four words — seven syllables — inside 300ms.
    Twenty syllables a second is not singing; the fastest rap is ten. So a stretch that dense is
    not a performance, it is a boundary in the wrong place.

    A word below its floor pulls in whichever neighbours it must until the stretch is long enough
    to hold them all, then the stretch is divided by syllable count. Nothing moves out of order
    and no time is invented — the stretch is as long as it was. Checked against the transcriber,
    an independent witness: the line above became 아빠옆에 58.18, 못 59.33, 남아 59.61, 도망쳐
    60.03, where the transcriber heard 58.32, 59.08, 59.32, 59.88 — the four words that had
    shared 300ms now hold 1.1 seconds between them.
    """
    line_of_token: dict[int, int] = {}
    tokens_of_line: dict[int, list[int]] = {}
    position = 0
    for line_index, count in enumerate(counts):
        for offset in range(max(0, count)):
            line_of_token[position + offset] = line_index
        position += max(0, count)
    for index, word in enumerate(words):
        line_index = line_of_token.get(int(word[0]))
        if line_index is not None:
            tokens_of_line.setdefault(line_index, []).append(index)

    for line_index, indices in tokens_of_line.items():
        floors = [max(MIN_WORD_MS, MIN_SYLLABLE_MS * weight_of(weights, int(words[index][0]))) for index in indices]
        settled: set[int] = set()
        while True:
            crushed = next(
                (
                    k
                    for k in range(len(indices))
                    if k not in settled and float(words[indices[k]][2]) - float(words[indices[k]][1]) < floors[k] - 0.5
                ),
                None,
            )
            if crushed is None:
                break
            low = high = crushed
            span = float(words[indices[high]][2]) - float(words[indices[low]][1])
            while span < sum(floors[low : high + 1]) and (low > 0 or high < len(indices) - 1):
                # 삼킨 쪽은 대개 앞이다. 앞이 없을 때만 뒤에서 가져온다.
                if low > 0:
                    low -= 1
                else:
                    high += 1
                span = float(words[indices[high]][2]) - float(words[indices[low]][1])
            share = sum(weights_in(weights, words, indices, low, high))
            cursor = float(words[indices[low]][1])
            for k in range(low, high + 1):
                width = span * weight_of(weights, int(words[indices[k]][0])) / share if share > 0 else span / (high - low + 1)
                words[indices[k]][1] = round(cursor)
                cursor += width
                words[indices[k]][2] = round(cursor)
            settled.update(range(low, high + 1))
        first, last = words[indices[0]], words[indices[-1]]
        if line_index < len(lines):
            lines[line_index][0] = min(lines[line_index][0], int(first[1]))
            lines[line_index][1] = max(lines[line_index][1], int(last[2]))


def weight_of(weights: list[float], token_index: int) -> float:
    return weights[token_index] if 0 <= token_index < len(weights) else 1.0


def weights_in(weights: list[float], words: list[list[int | float]], indices: list[int], low: int, high: int) -> list[float]:
    return [weight_of(weights, int(words[indices[k]][0])) for k in range(low, high + 1)]


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


# ── 여러 글자를 한 사전으로 맞추는 정렬기 ──────────────────────────────────
# 언어별 정렬 모델은 제 언어의 글자만 안다: 한국어 모델의 사전은 한글 1202자에 라틴 0자,
# 숫자 0자다. 그래서 한국어 가사에 섞인 "in", "kawaii", "2" 는 찾을 대상이 아니라 와일드
# 카드로 흘러간다. MMS 는 어떤 글자든 로마자로 옮긴 뒤 맞추므로 그 낱말들을 읽을 수 있다.
# 대신 언어를 가리지 않는 만큼 제 언어에서는 덜 정밀하다 — 실측한 줄에서 MMS 는 "가방에"
# 를 180ms 로 눌렀고 한국어 모델은 620ms 를 주었다. 그래서 읽을 수 없는 낱말만 맡긴다.
MMS_DIGITS = {"0": "yeong", "1": "won", "2": "tu", "3": "sseuri", "4": "po", "5": "paibeu", "6": "siksseu", "7": "sebeun", "8": "eiteu", "9": "nain"}
mms_cache: dict[str, Any] = {}


def mms_ready() -> bool:
    return module_exists("torchaudio") and module_exists("uroman")


def spelled_out(word: str) -> str:
    """The word in the Latin letters the multilingual aligner reads, or "" when nothing is left."""
    import uroman

    romanizer = mms_cache.get("uroman")
    if romanizer is None:
        romanizer = mms_cache["uroman"] = uroman.Uroman()
    sounded = romanizer.romanize_string(word).lower()
    sounded = "".join(MMS_DIGITS.get(character, character) for character in sounded)
    return re.sub(r"[^a-z']", "", sounded)


def mms_voice(vocals: Path) -> tuple[Any, float] | None:
    """The multilingual model's read of the whole vocal, and seconds per frame. Computed once."""
    if mms_cache.get("voice_of") == str(vocals):
        return mms_cache.get("voice")
    try:
        import torch
        import torchaudio
        from torchaudio.pipelines import MMS_FA as bundle

        with redirect_stdout(sys.stderr):
            wave, rate = torchaudio.load(str(vocals))
            wave = torchaudio.functional.resample(wave.mean(dim=0, keepdim=True), rate, bundle.sample_rate)
            model = mms_cache.get("model")
            if model is None:
                model = mms_cache["model"] = bundle.get_model()
                mms_cache["tokenizer"] = bundle.get_tokenizer()
                mms_cache["aligner"] = bundle.get_aligner()
            with torch.inference_mode():
                emission, _ = model(wave)
        voice = (emission, wave.size(1) / emission.size(1) / bundle.sample_rate)
    except Exception as error:
        print(f"[mms] unavailable error={type(error).__name__}: {error}", file=sys.stderr)
        voice = None
    mms_cache["voice_of"] = str(vocals)
    mms_cache["voice"] = voice
    return voice


def mms_line_spans(voice: tuple[Any, float], window: list[int], written: list[str]) -> dict[int, tuple[float, float]]:
    """Where the multilingual aligner puts each word of this line, in milliseconds."""
    emission, ratio = voice
    spelled = [spelled_out(word) for word in written]
    usable = [position for position, sound in enumerate(spelled) if sound]
    low = max(0, int(window[0] / 1000 / ratio))
    high = min(int(emission.size(1)), int(window[1] / 1000 / ratio) + 1)
    if not usable or high - low < len(usable) + 2:
        return {}
    try:
        import torch

        with torch.inference_mode():
            spans = mms_cache["aligner"](emission[0, low:high], mms_cache["tokenizer"]([spelled[p] for p in usable]))
    except Exception as error:
        print(f"[mms] line skipped error={type(error).__name__}: {error}", file=sys.stderr)
        return {}
    placed: dict[int, tuple[float, float]] = {}
    for position, span in zip(usable, spans):
        placed[position] = ((low + span[0].start) * ratio * 1000, (low + span[-1].end) * ratio * 1000)
    return placed


def lend_spans(candidates: list[dict[str, Any]], borrowed: dict[int, tuple[float, float]], positions: list[int]) -> int:
    """
    Give the named words the multilingual aligner's answer, without disturbing the rest.

    The words around them were read by a model that has their letters, so those boundaries are
    measurements and are not crossed. Words the model could not read are handled together when
    they sit side by side: clamping each against its neighbour would mean clamping against the
    wildcard time this is meant to replace, and on a measured line that threw away the borrow
    for "in" while keeping the one for "the", leaving the pair further apart than either model
    said. Nothing is reordered and no readable neighbour is shortened.
    """
    taken = 0
    for first, last in runs_of(positions):
        floor = float(candidates[first - 1]["end"]) if first > 0 else float("-inf")
        ceiling = float(candidates[last + 1]["start"]) if last + 1 < len(candidates) else float("inf")
        cursor = floor
        for offset, position in enumerate(range(first, last + 1)):
            span = borrowed.get(position)
            remaining = last - position
            if span is None:
                cursor = max(cursor, float(candidates[position]["end"]))
                continue
            room = ceiling - MIN_WORD_MS / 1000 * remaining
            start = max(span[0] / 1000, cursor)
            end = min(span[1] / 1000, room)
            if end - start < MIN_WORD_MS / 1000:
                cursor = max(cursor, float(candidates[position]["end"]))
                continue
            candidates[position] = {**candidates[position], "start": start, "end": end}
            cursor = end
            taken += 1
    return taken


def runs_of(positions: list[int]) -> list[tuple[int, int]]:
    """Consecutive positions grouped together: [1,2,5] becomes [(1,2),(5,5)]."""
    grouped: list[tuple[int, int]] = []
    for position in sorted(set(positions)):
        if grouped and position == grouped[-1][1] + 1:
            grouped[-1] = (grouped[-1][0], position)
        else:
            grouped.append((position, position))
    return grouped


def align_line(
    line: str, window_start: float, window_end: float, whisperx: Any, model: Any, metadata: Any, audio: Any, device: str
) -> list[dict[str, Any]]:
    """
    Every word the forced aligner placed for this one line.

    The aligner is asked one line at a time because it does not answer one segment per segment.
    It re-cuts each segment into sentences, so a line that ends a sentence part-way — "그래도
    제발 나를 사랑해줄래? (꺼져)" — comes back as two, and it merges segments that share a
    start and an end. Reading the answers back by line number therefore drifts: on the measured
    song two lines carried a question mark, the list came back 34 long for 32 lines, and from
    the first of them every line was given the line before's audio — the last third of the song
    sat two lines early. Asking per line, whatever comes back belongs to the line that asked.
    """
    aligned = whisperx.align(
        [{"start": window_start, "end": window_end, "text": line}], model, metadata, audio, device, return_char_alignments=True
    )
    return [word for part in aligned.get("segments", []) for word in part.get("words", [])]


def align_variant(
    vocals: Path,
    variant: dict[str, Any],
    asr: dict[str, Any],
    duration_ms: int,
    backend: str,
    detected: str = "und",
    second_voice: list[tuple[float, float]] | None = None,
) -> dict[str, Any]:
    text_lines = [line for line in str(variant["text"]).splitlines() if line.strip()]
    counts = [int(value) for value in variant.get("token_counts", [])]
    if len(counts) != len(text_lines):
        counts = [max(1, len(line.split())) for line in text_lines]
    # Where the transcriber actually heard these words beats dividing the song by word count.
    lyric_words = [comparable(word) for line in text_lines for word in line.split() if comparable(word)]
    start, end = audio_bounds(asr, duration_ms, lyric_words)
    proportional_windows, fallback_words = proportional_spans(counts, start, end)
    heard_words = asr_words(asr)
    # 되짚어 갈 바닥은 소리가 시작하는 곳이다. 시작점은 가사가 처음 들리는 곳이라 말하는
    # 인트로를 건너뛰지만, 그 앞에 놓일 줄들에게는 자리가 남아 있어야 한다.
    anchored = anchored_windows(
        counts,
        lyric_words,
        heard_words,
        start,
        end,
        floor=audio_bounds(asr, duration_ms)[0],
        backing=[flag for line in text_lines for word, flag in zip(line.split(), bracket_mask(line)) if comparable(word)],
    )
    # When was each line's first word heard — the counter-witness against leading noise.
    anchors = match_sequences(lyric_words, heard_words)
    line_start_witness_ms: dict[int, float] = {}
    # 그리고 낱말마다: 받아쓰기가 그 낱말을 들은 시각. 줄 안에서 경계를 다시 긋는 데 쓴다.
    witness_ms: dict[int, float] = {}
    word_offset = 0
    token_offset = 0
    for line_index, line in enumerate(text_lines):
        written = line.split()
        line_word_count = len([word for word in written if comparable(word)])
        opening = anchors.get(word_offset)
        if line_word_count > 0 and opening is not None:
            line_start_witness_ms[line_index] = float(opening["start"]) * 1000
        # 토큰이 낱말과 하나씩 맞아떨어질 때만 증언을 토큰에 붙일 수 있다.
        count = counts[line_index] if line_index < len(counts) else 0
        if count == len(written):
            spoken = word_offset
            for position, word in enumerate(written):
                if not comparable(word):
                    continue
                heard_here = anchors.get(spoken)
                if heard_here is not None:
                    witness_ms[token_offset + position] = float(heard_here["start"]) * 1000
                spoken += 1
        word_offset += line_word_count
        token_offset += count
    line_windows = anchored or [span[:] for span in proportional_windows]
    anchored_by_asr = anchored is not None
    try:
        import whisperx
        declared = str(variant.get("language", "und")).split("-")[0]
        language = written_language(str(variant["text"]), declared)
        if language != declared:
            print(f"[align] lyric is filed as {declared} but written in {language}; using the {language} aligner", file=sys.stderr)
        device = "cuda" if backend == "cuda" else "cpu" if backend == "mps" else backend
        with redirect_stdout(sys.stderr):
            model, metadata = whisperx.load_align_model(language_code=language, device=device)
            audio = whisperx.load_audio(str(vocals))
            aligned_segments = [
                align_line(line, line_windows[index][0] / 1000, line_windows[index][1] / 1000, whisperx, model, metadata, audio, device)
                for index, line in enumerate(text_lines)
            ]
        # 이 모델이 글자로 가지고 있지 않은 낱말은 어느 줄에 있는가.
        alphabet = {str(character).lower() for character in (metadata.get("dictionary") or {})}
        illegible: dict[int, list[int]] = {}
        for line_index, line in enumerate(text_lines):
            spots = [
                position
                for position, word in enumerate(line.split())
                if comparable(word) and not any(character in alphabet for character in comparable(word))
            ]
            if spots:
                illegible[line_index] = spots
        borrowed_lines: dict[int, dict[int, tuple[float, float]]] = {}
        if illegible and mms_ready():
            voice = mms_voice(vocals)
            if voice is not None:
                for line_index in illegible:
                    borrowed_lines[line_index] = mms_line_spans(voice, line_windows[line_index], text_lines[line_index].split())
        result_words: list[list[int | float]] = []
        borrowed_words = 0
        aligned_token_weight = 0.0
        token_index = 0
        # Which token ends each line, so a held note can be given the length it is held for.
        last_token_of_line: dict[int, int] = {}
        for line_index, count in enumerate(counts):
            # Every word of the line, in the order it is written — including the ones the
            # aligner could not place, which are given a spot between their neighbours.
            heard_in_line = aligned_segments[line_index] if line_index < len(aligned_segments) else []
            candidates = fill_unaligned(heard_in_line, line_windows[line_index][0] / 1000, line_windows[line_index][1] / 1000)
            if line_index in borrowed_lines and len(candidates) == count:
                borrowed_words += lend_spans(candidates, borrowed_lines[line_index], illegible[line_index])
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
                # 정렬기가 이 줄에서 아무것도 못 찾았다. 곡 전체를 낱말 수로 나눈 자리를 쓰면
                # 이 줄의 창과 아무 상관 없는 데로 간다 — 실측에서 첫 줄이 30초에 놓였고, 창은
                # 12.6초였다. 창을 아는데 곡 전체를 다시 짐작할 이유가 없다.
                result_words.extend(spread_in_window(line_windows[line_index], token_index, count, token_weights(text_lines, counts)))
            token_index += count
            last_token_of_line[token_index - 1] = line_index
        snap_line_starts(result_words, line_windows, counts, line_start_witness_ms)
        extend_held_endings(result_words, line_windows, last_token_of_line, heard_words)
        snap_words_to_witness(result_words, counts, witness_ms)
        weights = token_weights(text_lines, counts)
        spread_crushed_words(result_words, line_windows, counts, weights)
        # 겹쳐 부른 말은 옆에 적혀 있을 뿐 뒤에 부른 것이 아니다. 들린 자리가 있으면 그리로.
        place_backing_runs(result_words, counts, text_lines, weights, second_voice or [])
        close_lines_over_words(result_words, line_windows, counts)
        coverage = aligned_token_weight / max(1, sum(counts))
        quality = measure(result_words, line_windows, coverage, duration_ms, anchored_by_asr, declared, detected)
        if borrowed_words:
            print(f"[mms] borrowed {borrowed_words} word(s) the {language} aligner has no letters for", file=sys.stderr)
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
    asr, detected = coarse_asr(stems["vocals"], expected_language(job), config["backend"])
    asr = redo_invented_segments(asr, "\n".join(str(variant.get("text", "")) for variant in job.get("lyrics", [])), stems["vocals"], config["backend"])
    notify("coarse_asr", "completed", 0.64)
    # 리드 위에 겹쳐 부른 목소리는 받아쓰기에 한 글자도 남지 않는다. 읽을 수는 없어도
    # 들린 자리는 잴 수 있고, 괄호로 적힌 가사는 그 자리에 놓는다.
    second_voice: list[tuple[float, float]] = []
    if os.getenv("MORA_SPLIT_VOICES", "1") != "0":
        notify("split_voices", "started", 0.645)
        split = split_voices(stems["vocals"], directory, config["backend"])
        if split is not None:
            second_voice = second_voice_regions(*split)
        # 갈라내지 못한 것은 실패가 아니다 — 겹쳐 부른 목소리를 못 들었을 뿐이고, 그 사실은
        # 상태가 아니라 숫자로 전한다. 단계 상태는 서버가 아는 네 가지뿐이다.
        notify("split_voices", "completed", 0.65, {"split": 1.0 if split is not None else 0.0, "regions": float(len(second_voice))})
    notify("language_validate", "started", 0.65)
    validate_language(detected, str(job["recording"].get("language", "und")))
    notify("forced_align", "started", 0.66)
    variants = [align_variant(stems["vocals"], variant, asr, duration_ms, config["backend"], detected, second_voice) for variant in job["lyrics"]]
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
    # 겹쳐 부른 목소리도 남긴다 — 괄호 가사의 자리를 여기서 쟀으니, 의심되면 들어볼 수 있게.
    backing = directory / "backing.wav"
    if backing.exists():
        encoded = directory / "backing.m4a"
        run_command(["ffmpeg", "-y", "-i", str(backing), "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(encoded)], "STEM_ENCODE_FAILED")
        artifacts.append({"kind": "other", "path": str(encoded), "content_type": "audio/mp4"})
    artifacts.extend(speaker_artifacts)
    notify("speaker_stems", "completed", 0.92)
    notify("index", "started", 0.93)
    artifacts.append({"kind": "waveform", "path": str(waveform(mixture, directory)), "content_type": "application/json"})
    # 받아쓰기는 가사가 아니라 "그 말이 몇 초에 나왔나"를 대는 증인이다. 정렬이 이상할 때
    # 물어야 할 첫 질문이 "무엇을 들었나"인데, 그 답이 체크포인트 안에 묻혀 있어서 매번
    # 파이프라인을 손으로 다시 돌려야 했다. 사람이 읽을 수 있게 따로 남긴다.
    heard = asr_words(asr)
    transcript = directory / "transcript.json"
    transcript.write_text(
        json.dumps(
            {
                "detected": detected,
                "text": " ".join(word["text"] for word in heard),
                "words": [{"t": round(word["start"], 2), "e": round(word["end"], 2), "w": word["text"]} for word in heard],
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    artifacts.append({"kind": "transcript", "path": str(transcript), "content_type": "application/json"})
    checkpoint = directory / "checkpoint.json"
    checkpoint.write_text(json.dumps({"pipeline": job["pipeline"], "detected": detected, "variants": variants}, separators=(",", ":")), encoding="utf-8")
    artifacts.append({"kind": "checkpoint", "path": str(checkpoint), "content_type": "application/json"})
    notify("index", "completed", 0.95)
    notify("quality_gate", "completed", 0.96)
    # expected_language 함수와 이름이 겹치면 파이썬이 함수 전체에서 그 이름을 지역으로 봐,
    # 위쪽의 호출이 "값 없는 지역 변수"로 죽는다. 실제로 그렇게 죽었다.
    stated_language = str(job["recording"].get("language", "und"))
    average = lambda key: sum(float(item["quality"].get(key, 0.0)) for item in variants) / max(1, len(variants))
    quality = {
        "token_coverage": average("token_coverage"),
        "monotonicity": average("monotonicity"),
        "line_plausibility": average("line_plausibility"),
        "asr_anchored": average("asr_anchored"),
        "duration_match": max(0.0, 1 - abs(duration_ms - int(job["recording"]["duration_ms"])) / 10000),
        "language_match": 1.0 if stated_language == "und" or detected.split("-")[0] == stated_language.split("-")[0] else 0.0,
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
