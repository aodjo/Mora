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


def module_loads(name: str) -> bool:
    """
    Whether the module can actually be imported, not merely found.

    find_spec only asks whether the files are on disk; it never runs them, so a package whose
    own dependency is missing still answers yes. On the measured box audio_separator was
    installed but audioread was not, the self-test reported split_voices passed, and the stage
    quietly skipped itself on every song — a check that says "ready" about something that
    cannot start is worse than no check.
    """
    try:
        importlib.import_module(name)
        return True
    except Exception as error:
        print(f"[self_test] {name} 을(를) 불러오지 못했습니다 — {type(error).__name__}: {error}", file=sys.stderr)
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
        # 이 단계는 실패해도 곡을 세우지 않고 조용히 건너뛴다. 그래서 여기서만은 "찾았다" 가
        # 아니라 "불러와진다" 를 물어야 한다 — 아무도 소리를 내지 않을 것이므로.
        "split_voices": "passed" if module_loads("audio_separator") else "skipped",
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
    # 이 데몬의 stdin 은 Node 와 주고받는 JSON-RPC 파이프다. 물려 주면 ffmpeg 가 거기서
    # 대화형 명령을 읽으려 들어 우리가 읽어야 할 요청을 먹는다 — 실제로 재현하면 "Enter
    # command:" 를 찍고 8초짜리 파일에 27초를 매달려 있었다. 호출부는 모두 파일 경로를
    # 넘기고 pipe: 나 - 로 표준입력에서 읽는 곳은 없으니, 아무것도 주지 않는 편이 옳다.
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        raise RuntimeError(code)


def probe(path: Path) -> dict[str, Any]:
    result = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        raise RuntimeError("FFPROBE_FAILED")
    return json.loads(result.stdout)


def downloaded(directory: Path) -> Path | None:
    candidates = [path for path in directory.glob("source.*") if path.suffix not in (".part", ".m4a")]
    return candidates[0] if candidates else None


# 실패가 이 곡의 성질인가, 지금 이 연결의 사정인가. 앞엣것이면 다음 후보로 넘어가는 것이
# 옳고, 뒤엣것이면 넘어가서는 안 된다 — 아래 wrong_length 를 보라.
PASSING_TROUBLE = re.compile(
    r"connection refused|failed to establish|temporary failure|timed out|read timeout"
    r"|connection reset|network is unreachable|proxy|socks"
    r"|sign in to confirm you.{0,3}re not a bot"
    r"|http error (?:429|5\d\d)"
    r"|unable to download (?:webpage|api page)",
    re.IGNORECASE,
)

# 곡 메타데이터와 실제 음원의 길이 차이를 어디까지 같은 곡으로 볼 것인가.
#
# 제대로 맞은 70 곡에서 재니 가운뎃값이 0.0 초, 가장 벌어진 것이 2.4 초였고 5 초를 넘는 곡은
# 하나도 없었다. 마스터가 다르거나 앞뒤에 잠깐이 붙는 정도가 그 폭이다. 다른 곡은 보통 수십
# 초씩 벌어지므로, 관측 최대의 네 배쯤에 두면 정상을 자르지 않으면서 남을 잡는다.
SAME_SONG_SECONDS = 10.0


def wrong_length(path: Path, job: dict[str, Any]) -> float | None:
    """받아 온 음원이 이 곡이 아닐 때, 얼마나 어긋났는지. 맞으면 None."""
    wanted = int(job.get("recording", {}).get("duration_ms") or 0)
    if wanted <= 0:
        return None
    try:
        got = float(probe(path).get("format", {}).get("duration", 0)) * 1000
    except Exception:
        return None
    if got <= 0:
        return None
    apart = abs(got - wanted) / 1000.0
    return apart if apart > SAME_SONG_SECONDS else None


def download(job: dict[str, Any], directory: Path, cookie_file: str | None, proxy: str | None = None) -> Path:
    """
    The audio, from the first source that gives it up.

    YouTube signs its media URLs with a challenge that has to be run as JavaScript. yt-dlp only
    looks for deno by default, and without a runtime it falls back to a client whose URLs come
    back 403 Forbidden. Node is always here — the worker that calls this daemon is a Node
    program — so it is offered as a runtime rather than left unfound.

    프록시는 환경변수가 아니라 여기에서만 건다. HTTPS_PROXY 로 걸면 같은 프로세스의 파이썬이
    내려받는 것 — 언어마다 다른 정렬 모델 수 GB — 까지 전부 그리로 나간다. 데이터센터 IP 를
    가리려고 필요한 것은 유튜브로 가는 길 하나뿐이고, 그 길은 곡당 몇 MB 다. 자릿수가 다르다.
    """
    urls = [job["source"]["url"], *job["source"].get("alternatives", [])]
    refused: list[str] = []
    for url in urls:
        output = directory / "source.%(ext)s"
        # 어느 node 인지까지 대 준다. 이름만 넘기면 PATH 에서 찾는데, 로그인 셸이 아닌 곳에서는
        # 없다고 나오고 그러면 서명 없는 클라이언트로 떨어져 봇 확인 화면을 받는다.
        runtime = f"node:{os.environ['MORA_NODE']}" if os.getenv("MORA_NODE") else "node"
        args = ["yt-dlp", "--no-playlist", "--no-write-info-json", "--js-runtimes", runtime, "-f", "bestaudio/best",
                # 같은 곡이 한 번은 403 으로 막히고 곧바로 다시 하면 받아진다. 서명된 미디어
                # 주소를 거절하는 것은 그때의 사정이지 곡의 성질이 아니므로, 한 번 튕겼다고
                # 다음 후보로 넘어가면 멀쩡한 음원을 두고 더 나쁜 것을 고르게 된다.
                # extractor-retries 는 주소를 새로 받아 오고, retries 는 그 주소로 다시 붙는다.
                "--retries", "10", "--extractor-retries", "5", "--fragment-retries", "10",
                "--retry-sleep", "http:exp=2:60", "--sleep-requests", "1",
                "-o", str(output)]
        if cookie_file:
            args += ["--cookies", cookie_file]
        if proxy:
            args += ["--proxy", proxy]
        args.append(url)
        result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if result.returncode == 0:
            existing = downloaded(directory)
            if existing is not None:
                # 받아 온 것이 이 곡이 맞는지. 대체 후보는 검수를 거치지 않은 순위표의 아랫줄이라
                # 다른 곡일 수 있고, 그러면 앵커가 하나도 안 잡힌다 — 그것은 화면에 "정렬이
                # 나빴다" 로만 보이고 무엇이 잘못됐는지는 말해 주지 않는다.
                apart = wrong_length(existing, job)
                if apart is None:
                    return existing
                existing.unlink(missing_ok=True)
                refused.append(f"{url}: 길이가 {apart:.0f}초 어긋난다 — 이 곡이 아니다")
                continue
        # yt-dlp 가 왜 안 됐는지 말했는데 그것을 버리면, 남는 것은 "안 됐다" 뿐이다.
        said = [line for line in result.stderr.splitlines() if line.strip()]
        why = said[-1] if said else f"exit {result.returncode}"
        refused.append(f"{url}: {why}")
        # 연결이 막힌 것을 곡이 없는 것으로 읽으면, 멀쩡한 1 순위를 두고 아랫줄로 내려간다.
        # 경유지가 죽은 동안 그렇게 돌아 세 곡이 다른 음원 위에 얹혔다. 이럴 때는 여기서
        # 멈춘다 — 작업은 잠시 뒤 같은 음원으로 다시 온다.
        if PASSING_TROUBLE.search(why):
            error = RuntimeError("SOURCE_UNREACHABLE")
            error.detail = "\n".join(refused)  # type: ignore[attr-defined]
            print(f"[download] 지금은 닿지 않는다, 다음 후보로 넘어가지 않는다\n{error.detail}", file=sys.stderr)
            raise error
    error = RuntimeError("YTDLP_FAILED")
    error.detail = "\n".join(refused)  # type: ignore[attr-defined]
    print(f"[download] {error.detail}", file=sys.stderr)
    raise error


def transcode(source: Path, directory: Path) -> Path:
    output = directory / "mixture.wav"
    run_command(["ffmpeg", "-y", "-i", str(source), "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s24le", str(output)], "TRANSCODE_FAILED")
    return output


def loudness(audio: Path) -> float:
    """RMS in dBFS, or -inf for silence. Read in blocks so a long file does not land in memory."""
    import numpy
    import soundfile

    total, samples = 0.0, 0
    with soundfile.SoundFile(str(audio)) as handle:
        while True:
            block = handle.read(1 << 20, dtype="float32", always_2d=True)
            if len(block) == 0:
                break
            total += float(numpy.sum(numpy.square(block, dtype=numpy.float64)))
            samples += block.size
    if samples == 0 or total <= 0.0:
        return float("-inf")
    return 10.0 * math.log10(total / samples)


# 목소리가 믹스보다 이만큼 아래면 분리가 아무것도 못 건진 것이다. 멀쩡한 곡은 6~7 dB
# 아래에 있고, 반주 음원은 61 dB 아래에 있었다 — 그 사이는 텅 비어 있어 문턱을 어디에
# 두든 같다. 절대값이 아니라 믹스 대비로 재는 것은 마스터가 조용한 음원 때문이다.
QUIET_VOICE_DB = float(os.getenv("MORA_QUIET_VOICE_DB", "-35"))


def separate(mixture: Path, directory: Path, backend: str) -> dict[str, Path]:
    output = directory / "demucs"
    stem_dir = output / "htdemucs_ft" / mixture.stem
    if not (stem_dir / "vocals.wav").exists():
        device = "mps" if backend == "mps" else "cuda" if backend == "cuda" else "cpu"
        run_command([sys.executable, "-m", "demucs", "-n", "htdemucs_ft", "--device", device, "--out", str(output), str(mixture)], "SEPARATION_FAILED")
    stems = {path.stem: path for path in stem_dir.glob("*.wav")}
    if "vocals" not in stems:
        raise RuntimeError("VOCALS_MISSING")
    # 반주 음원을 받아 온 것을 여기서 잡는다. 제목 필터는 "(Inst.)" 같은 줄임말마다 새고,
    # 새면 그 뒤가 전부 헛돈다 — 아무것도 못 들으니 앵커가 0 이 되고, 낱말은 전부 추측으로
    # 채워지며, 추측은 지표에 잘 나오므로 그대로 공개된다. 10CM "너에게 닿기를" 이 그랬다.
    # 여기서 재는 값은 이미 만들어 둔 파일 두 개를 읽는 것이 전부다.
    voice, whole = loudness(stems["vocals"]), loudness(mixture)
    if voice - whole < QUIET_VOICE_DB:
        print(f"[separate] 목소리가 믹스보다 {whole - voice:.0f} dB 아래다 — 반주 음원으로 본다", file=sys.stderr)
        raise RuntimeError("NO_VOCAL_TRACK")
    return stems


KARAOKE_MODEL = "mel_band_roformer_karaoke_gabox_v2.ckpt"


def model_cache() -> str:
    # 맥에서는 run-macos.sh 가 자리를 정해 준다. 도커/리눅스에서는 정해 주는 사람이 없으므로
    # 그쪽 관례를 따른다 — 아니면 500MB 짜리 모델이 /root/Library 같은 데로 간다.
    default = Path.home() / ("Library/Caches/Mora" if platform.system() == "Darwin" else ".cache/mora")
    directory = Path(os.getenv("MORA_CACHE_ROOT") or default) / "audio-separator"
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


def split_voices(vocals: Path, directory: Path) -> tuple[Path, Path] | None:
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

    No backend is passed because the separator picks its own: CUDA first, then Apple's MPS, then
    the processor. Telling it twice could only ever tell it something different.
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
        spoken = str(result.get("language", language))
        result = with_word_times(result, audio, spoken, device)
    return result, spoken


align_cache: dict[str, Any] = {}


def with_word_times(asr: dict[str, Any], audio: Any, language: str, device: str) -> dict[str, Any]:
    """
    받아쓴 말마다 그 말이 들린 시각. 앵커는 이것 없이는 하나도 만들어지지 않는다.

    whisperx 의 transcribe 는 문장만 돌려준다 — 세그먼트에 words 키가 아예 없다. 그런데
    앵커의 유일한 입력인 asr_words 는 그 words 를 읽으므로, 붙이지 않으면 빈 목록을 받고,
    match_sequences 는 {} 를, anchored_windows 는 None 을 돌려준다. 그러면 정렬기는 보컬
    구간을 단어 수로 나눈 창에 갇힌다 — 재어진 것이 아니라 짐작한 타이밍이다.

    맥은 mlx_whisper 에 word_timestamps=True 를 넘겨 이미 받고 있었다. 그래서 이 결함은
    한쪽에서만 보였다: 실측된 후보 9 건은 전부 mps 에서, 비례추정으로 떨어진 40 건은 전부
    cuda 에서 나왔다. 혁오 「위잉위잉」에서 문턱은 16~19 인데 앵커가 0 이었고, 여기를 붙이자
    174~196 이 되었다.

    맞춰 줄 모델이 없는 언어가 있다. coarse_asr 은 run_job 이 예외 없이 부르는 자리이므로,
    그때 터지면 곡 전체가 죽는다. 붙이지 못하면 붙이지 못한 채로 돌려준다 — 타이밍은 오늘과
    같아지지만 곡은 끝까지 간다.
    """
    segments = asr.get("segments") or []
    if not segments or any(segment.get("words") for segment in segments):
        return asr
    import whisperx

    code = language.split("-")[0]
    try:
        key = f"{code}:{device}"
        if key not in align_cache:
            align_cache[key] = whisperx.load_align_model(language_code=code, device=device)
        model, metadata = align_cache[key]
        aligned = whisperx.align(segments, model, metadata, audio, device, return_char_alignments=False)
    except Exception as error:
        print(f"[coarse_asr] {code} 는 단어 시각을 붙이지 못했다 — {type(error).__name__}: {error}", file=sys.stderr)
        return asr
    return {**asr, "segments": aligned.get("segments") or segments}


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
    rarely repeat the words of the song. A match so late that the lyric could not fit after it
    is a coincidence rather than the downbeat, and is not believed. With nothing to compare
    against, or nothing worth believing, the first sound is still the best guess available.
    """
    segments = asr.get("segments") or []
    if not segments:
        return 0.0, duration_ms / 1000.0
    first = max(0.0, float(segments[0].get("start", 0)))
    last = min(duration_ms / 1000.0, float(segments[-1].get("end", duration_ms / 1000.0)))
    if not lyric_words:
        return first, last
    # 음차가 어긋난 곡에서는 흔한 낱말 하나가 곡 끝에서 우연히 맞는다. min(..., last) 가 그
    # 답을 구간 안으로 다듬어 주는 탓에 아래에서는 멀쩡한 값과 구별되지 않는다 — 재현하면
    # 18낱말짜리 가사 전체가 170.6초부터 1.8초 안에 눌렸고, duration_match 는 끝만 보므로
    # 0.958 로 통과했다. 가사를 담을 자리가 남지 않는 시작점은 시작점이 아니다. 뒤로 갈수록
    # 자리는 줄기만 하니 여기서 멈추고 첫 소리로 돌아간다.
    track = duration_ms / 1000.0
    room = max(len(lyric_words) * 0.25, track * 0.2)
    wanted = set(lyric_words)
    for word in asr_words(asr):
        if word["text"] in wanted:
            if track - float(word["start"]) < room:
                break
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


def listen_again(vocals: Path, begin: float, finish: float, backend: str, language: str = "und") -> dict[str, Any] | None:
    """
    Transcribe one stretch on its own, letting the transcriber pick the language itself.

    상투구를 되살리는 쪽은 언어를 고르게 두어야 한다 — 한국어로 분류된 곡의 영어 후렴이
    그렇게 되살아났다. 빈 자리를 메우는 쪽은 그렇지 않을 수 있으므로 부르는 쪽에서 정한다.
    """
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
            heard, _ = coarse_asr(clip, language, backend)
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


SEMITONE = 2 ** (1 / 12)

# 소리를 조금씩 틀어 다시 듣는 벌들. (이름, ffmpeg 필터, 시각에 곱할 값).
#
# 오토튠은 음높이를 격자에 붙여 놓아 음소 경계를 뭉갠다. 반음쯤 옮기면 포먼트가 함께 움직여
# 그 격자에서 벗어나고, 받아쓰기가 다르게 듣는다. 어느 벌이 맞을지는 곡마다 다르고 미리 알
# 수 없다 — 코르티스 「REDRED」는 +2 반음에서 증언 없는 자리가 59 에서 31 낱말로 줄었는데
# 같은 벌이 Lil Baby 「Dead Fresh」에서는 51 을 95 로 늘렸고, -2 반음은 정확히 그 반대였다.
# 그래서 고르지 않고 전부 듣고 합친다. 틀리게 들은 말은 정렬에서 버려지므로 손해가 없다.
#
# 속도를 바꾼 벌은 시각이 그 배율만큼 어긋난다. 0.9 배로 늘였다면 늘인 소리의 T 초는 원본의
# T*0.9 초다. 되돌리지 않고 합치면 앵커는 늘고 타이밍은 망가진다 — 지표만 좋아 보이는 실패다.
AUGMENTS: tuple[tuple[str, str, float], ...] = (
    ("pitch+1", f"asetrate=44100*{SEMITONE},aresample=44100,atempo={1 / SEMITONE}", 1.0),
    ("pitch-1", f"asetrate=44100*{1 / SEMITONE},aresample=44100,atempo={SEMITONE}", 1.0),
    ("pitch+2", f"asetrate=44100*{SEMITONE ** 2},aresample=44100,atempo={1 / SEMITONE ** 2}", 1.0),
    ("pitch-2", f"asetrate=44100*{1 / SEMITONE ** 2},aresample=44100,atempo={SEMITONE ** 2}", 1.0),
    ("slow", "atempo=0.9", 0.9),
    ("fast", "atempo=1.1", 1.1),
)


def rescale_segments(asr: dict[str, Any], factor: float) -> dict[str, Any]:
    """늘이거나 줄인 소리에서 들은 시각을 원본의 시각으로 되돌린다.

    세그먼트째 옮긴다. 낱말만 옮기면 audio_bounds 가 보는 첫·끝 세그먼트와 어긋난다.
    """
    if factor == 1.0:
        return asr
    moved = []
    for segment in asr.get("segments") or []:
        words = [
            {**word, "start": float(word["start"]) * factor, "end": float(word["end"]) * factor}
            for word in (segment.get("words") or [])
            if "start" in word and "end" in word
        ]
        moved.append({
            **segment,
            "start": float(segment.get("start", 0)) * factor,
            "end": float(segment.get("end", 0)) * factor,
            **({"words": words} if segment.get("words") else {}),
        })
    return {**asr, "segments": moved}


def augmented_hearing(vocals: Path, language: str, backend: str) -> list[dict[str, Any]]:
    """소리를 틀어 가며 다시 들은 받아쓰기들. 시각은 모두 원본의 것으로 돌려 놓는다."""
    heard: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory() as scratch:
        for name, filters, factor in AUGMENTS:
            clip = Path(scratch) / f"{name}.wav"
            try:
                run_command(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", str(vocals),
                             "-af", filters, str(clip)], "AUGMENT_FAILED")
                asr, _ = coarse_asr(clip, language, backend)
            except Exception as error:
                print(f"[hear] {name} 을 듣지 못했다 — {type(error).__name__}", file=sys.stderr)
                continue
            heard.append(rescale_segments(asr, factor))
    return heard


def merged_words(*heard: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """여러 벌의 받아쓰기를 시각 순으로 꿴다. 앵커를 잡는 쪽은 순서를 보므로 시각이 실이다."""
    return sorted((word for batch in heard for word in batch), key=lambda word: (word["start"], word["end"]))


# 같은 자리를 가리킨다고 볼 시각 차이. 이보다 가까우면 두 벌이 같은 것을 들었다고 본다.
AGREE_SECONDS = 0.4


def consensus_words(lyric: list[str], batches: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """
    여러 벌이 저마다 잡은 앵커를 모아, 같은 자리를 가리키는 것끼리 표를 세어 하나로 정한다.

    벌을 통째로 한 목록에 쏟아붓고 한 번에 정렬하면 오히려 나빠진다. 글자 단위 Needleman-
    Wunsch 는 전역 최적을 찾으므로, 받아쓴 글자가 여덟 배가 되면 가사의 낱말이 엉뚱한 곳의
    비슷한 글자와 맞춰질 기회도 여덟 배가 되고 정렬 경로 전체가 다른 해로 옮겨간다. 실측하면
    Morgan Wallen 「Been By Now」은 앵커가 407 에서 394 로 줄었고, 어느 한 벌을 빼도 회복되지
    않았다 — 나쁜 벌 하나가 아니라 섞은 것 자체의 효과다.

    그래서 섞지 않는다. 벌마다 제 안에서 깨끗이 정렬해 앵커를 얻고, 그 앵커들만 모은다.
    여러 벌이 한 낱말을 같은 시각으로 가리키면 그것은 강한 증거다 — 서로 다른 소리에서 같은
    답이 나왔다는 뜻이므로. 한 벌만 가리키면 약한 증거이니 표가 많은 쪽을 택한다.

    다만 섞기에도 제 몫이 있다. 전역 정렬은 어느 벌도 혼자서는 못 찾은 매칭을 찾아내므로,
    섞기도 한 표를 받는다 — 빈 자리를 메울 뿐 아니라 이미 표가 있는 자리의 다수결에도 참여한다.

    한동안 이 설명은 "빈 자리만 메운다" 고 적혀 있었고 코드는 그렇지 않았다. 어느 쪽이 옳은지
    141 곡으로 재어 보니 코드 쪽이었다 — 모든 자리에 표를 주면 최장 빈 구간 평균 6.8, 빈 자리만
    메우면 6.9 이고, 빈 구간이 20 을 넘는 곡은 6 대 8 이다. 차이는 작지만 방향이 일정하다.
    글을 코드에 맞춘다.
    """
    votes: dict[int, list[dict[str, Any]]] = {}
    for batch in batches:
        for index, word in match_sequences(lyric, batch).items():
            votes.setdefault(index, []).append(word)

    # 벌을 통째로 섞어 한 번에 정렬하면, 어느 개별 벌도 찾지 못한 매칭이 나온다 — 米津玄師
    # 「IRIS OUT」에서 벌마다 따로 세면 앵커가 61 개인데 섞으면 79 개였다. 정렬이 전역 최적을
    # 찾기 때문이고, 그것이 섞기의 장점이자 단점이다. 그래서 뼈대는 표로 세우고, 표가 하나도
    # 없는 자리만 섞기에서 가져온다. 시각을 정하는 일은 여전히 표가 한다.
    if len(batches) > 1:
        for index, word in match_sequences(lyric, merged_words(*batches)).items():
            votes.setdefault(index, []).append(word)

    agreed: list[dict[str, Any]] = []
    for index, heard in sorted(votes.items()):
        # 가까운 시각끼리 묶는다. 가장 큰 무리가 이기고, 그 무리의 가운뎃값을 쓴다.
        heard.sort(key=lambda word: word["start"])
        best: list[dict[str, Any]] = []
        for start in range(len(heard)):
            group = [word for word in heard[start:] if word["start"] - heard[start]["start"] <= AGREE_SECONDS]
            if len(group) > len(best):
                best = group
        middle = best[len(best) // 2]
        agreed.append({
            # 가사의 낱말 그대로 적는다 — 이 목록은 "이렇게 들렸다고 믿는 것"이고, 뒤에서
            # 다시 정렬될 때 제 자리를 찾아야 한다.
            "text": lyric[index],
            "start": float(middle["start"]),
            "end": float(middle["end"]),
            "votes": len(best),
        })
    agreed.sort(key=lambda word: (word["start"], word["end"]))
    return agreed


def merge_segments(asr: dict[str, Any], *others: dict[str, Any]) -> dict[str, Any]:
    """받아쓰기 여러 벌을 한 벌로 합친다 — 세그먼트를 시각 순으로 꿰기만 한다."""
    segments = [*(asr.get("segments") or [])]
    for other in others:
        segments.extend(other.get("segments") or [])
    segments.sort(key=lambda segment: float(segment.get("start", 0)))
    return {**asr, "segments": segments}


def hear_everything(vocals: Path, language: str, backend: str, lyric_words: list[str]) -> tuple[dict[str, Any], str]:
    """
    가사의 낱말마다 그것이 들린 자리를 찾을 때까지 듣는다.

    한 번 듣고 마는 것으로는 모자란다. 코르티스 「REDRED」는 오토튠에 가사의 68% 가 영어라
    한국어로 강제된 받아쓰기가 "kickin in" 을 "키기니" 로 들었고, 366 낱말 중 앵커가 붙은 것은
    69 개뿐이었다 — 문턱(30)은 넉넉히 넘었으나 증언 없이 이어 간 자리가 59 낱말에 이르렀고,
    그 사이는 두 앵커를 균등히 나눈 짐작이다.

    두 가지를 한다. 먼저 모국어와 영어로 각각 듣고 합친다 — 12 곡에서 재니 8 곡이 늘고 줄어든
    곡은 없었으며, 순한국어 곡(라틴 5%)조차 손해가 없었다. 정렬기가 Needleman-Wunsch 라
    남는 말을 건너뛸 수 있기 때문이다.

    그다음, 그러고도 비어 있는 자리를 찾아 그 구간만 잘라 다시 듣는다. 짧게 들려주면 그
    구간의 소리로 언어가 정해지고, 온 곡에 눌려 묻혔던 말이 드러난다. 새로 들은 것이 없으면
    멈춘다 — 같은 자리를 다시 들어도 같은 답이 온다.
    """
    asr, detected = coarse_asr(vocals, language, backend)
    native = (detected or language or "und").split("-")[0]
    # 벌마다 따로 둔다. 섞어서 한 번에 정렬하면 잡음이 정렬 경로 전체를 흔든다.
    batches: list[list[dict[str, Any]]] = [asr_words(asr)]
    # 한 번 듣고 이미 촘촘하면 거기서 그친다. 여러 벌은 못 들은 자리를 메우려는 것인데 메울
    # 자리가 없으면 앵커만 더 얹고, 새로 온 앵커가 어긋난 시각에 놓이면 단조성을 지키려는
    # 정렬이 멀쩡한 이웃을 버린다 — 이미 잘 맞던 곡이 도리어 나빠지는 길이다.
    #
    # 144곡 실측. 늘 여덟 벌을 듣던 것과 견주어 최장 빈 구간이 6낱말 이하인 곡을 원본만으로
    # 끝냈을 때: 빈 구간 8낱말 이하인 곡 108개로 같고, 합의가 도리어 망친 곡은 5→2,
    # 앵커 밀도는 85.6%→84.7%. 그러면서 144곡 중 64곡이 나머지 일곱 벌을 듣지 않는다.
    if lyric_words and HEAR_ENOUGH_GAP > 0 and longest_anchor_gap(lyric_words, consensus_words(lyric_words, batches)) <= HEAR_ENOUGH_GAP:
        print("[hear] 원본 한 벌로 촘촘하다 — 나머지 벌은 듣지 않는다", file=sys.stderr)
        return asr, detected
    # 영어가 아니면 영어로도 한 벌 듣는다. 코드스위칭 가사에서 모국어 강제가 놓치는 자리다.
    if native not in ("en", "und"):
        english, _ = coarse_asr(vocals, "en", backend)
        asr = merge_segments(asr, english)
        batches.append(asr_words(english))
    if AUGMENT_HEARING:
        for heard in augmented_hearing(vocals, native, backend):
            asr = merge_segments(asr, heard)
            batches.append(asr_words(heard))
    if not lyric_words:
        return asr, detected

    for _round in range(GAP_ROUNDS):
        gaps = anchor_gaps(lyric_words, consensus_words(lyric_words, batches))
        if not gaps:
            break
        found = 0
        for begin, finish in gaps[:GAP_CLIPS]:
            again = listen_again(vocals, begin, finish, backend, GAP_LANGUAGE or native)
            if again is None:
                continue
            fresh = again.get("segments") or []
            found += sum(len(segment.get("words") or []) for segment in fresh)
            asr = merge_segments(asr, again)
            batches.append(asr_words(again))
        print(f"[hear] 빈 자리 {len(gaps)}곳을 다시 들어 낱말 {found}개를 더 얻었다", file=sys.stderr)
        if found == 0:
            break

    # 앵커를 잡는 쪽은 이 목록을 본다. 세그먼트는 audio_bounds 와 상투구 검사가 쓰므로
    # 그대로 남겨 둔다 — 둘은 다른 것을 묻는다.
    agreed = consensus_words(lyric_words, batches)
    if agreed:
        asr = {**asr, "consensus_words": agreed}
        print(f"[hear] {len(batches)}벌에서 앵커 {len(agreed)}개를 모았다 "
              f"(둘 이상이 같은 자리를 가리킨 것 {sum(1 for w in agreed if w['votes'] > 1)}개)", file=sys.stderr)
    return asr, detected


# 빈 자리를 몇 번까지 되짚어 들을지, 한 번에 몇 곳까지 볼지. 곡마다 whisper 를 다시 돌리는
# 일이므로 값이 커지면 처리 시간이 그만큼 늘어난다.
GAP_ROUNDS = 2
GAP_CLIPS = 6
# 되짚어 들을 때 어느 언어로 들을지. 빈 문자열이면 곡의 언어를 쓰고, "und" 면 조각마다 스스로
# 고르게 둔다. 스스로 고르게 두었더니 어떤 조각을 프랑스어로 판정해 그 언어의 정렬 모델을
# 내려받는 일이 있었다 — 합치기만 하므로 해는 없으나 값을 치른다.
GAP_LANGUAGE = os.getenv("MORA_GAP_LANGUAGE", "")
# 소리를 틀어 여러 벌 듣는 일. 곡당 여섯 벌을 더 듣게 되므로 1 분 남짓이 더 든다.
AUGMENT_HEARING = os.getenv("MORA_AUGMENT_HEARING", "1") != "0"
# 이보다 짧게 빈 것은 되짚어 들을 값어치가 없다 — 한두 낱말은 원래 안 들리기도 한다.
GAP_WORDS = 8
# 원본 한 벌로 이만큼까지만 비어 있으면 더 듣지 않는다. 0 이면 늘 전부 듣는다(옛 동작).
# 6 은 144곡에서 고른 값이다. 곡을 반씩 40회 갈라 한쪽에서 문턱을 고르고 다른 쪽에서 재
# 보았더니 고른 문턱이 고정값보다 못했다 — 곡선이 평평해서, 값을 자료로 고르는 것 자체가
# 잡음을 따라가는 일이었다. 그래서 자료가 가리키는 범위(0~8) 안에서 손해가 가장 작은 쪽을
# 택했다: 밀도는 0.9%p 만 내주고 여덟 벌을 다 듣는 곡을 144→80 으로 줄인다.
HEAR_ENOUGH_GAP = int(os.getenv("MORA_HEAR_ENOUGH_GAP", "6"))


def longest_anchor_gap(lyric_words: list[str], heard: list[dict[str, Any]]) -> int:
    """
    증언 없이 이어진 가장 긴 낱말 수.

    anchor_gaps 는 되짚어 들을 자리를 시각으로 돌려주므로 앵커와 앵커 사이만 본다. 여기서
    묻는 것은 다른 것이다 — 이 받아쓰기가 가사를 얼마나 촘촘히 덮었는가. 그래서 첫 앵커
    앞과 마지막 앵커 뒤도 빈 자리로 센다. 밀도가 높아도 한 군데가 통째로 비어 있을 수 있고,
    사람이 어색함을 느끼는 것은 그 한 군데다.
    """
    if not lyric_words:
        return 0
    anchored = set(match_sequences(lyric_words, heard))
    longest = run = 0
    for index in range(len(lyric_words)):
        run = 0 if index in anchored else run + 1
        longest = max(longest, run)
    return longest


def anchor_gaps(lyric_words: list[str], heard: list[dict[str, Any]]) -> list[tuple[float, float]]:
    """
    증언이 없는 자리를, 그 앞뒤 앵커가 들린 시각으로 돌려준다.

    가사의 낱말 번호로는 어디가 비었는지 알 수 있어도 그것을 오디오의 어느 초에서 찾아야
    하는지는 알 수 없다. 빈 구간의 양옆에 붙은 앵커가 그 답을 들고 있다 — 앞 앵커가 들린 뒤,
    뒤 앵커가 들리기 전 어딘가에서 그 낱말들이 불렸다.
    """
    anchors = match_sequences(lyric_words, heard)
    if not anchors:
        return []
    placed = sorted(anchors)
    spans: list[tuple[float, float]] = []
    for index in range(len(placed) - 1):
        low, high = placed[index], placed[index + 1]
        if high - low - 1 < GAP_WORDS:
            continue
        begin, finish = float(anchors[low]["end"]), float(anchors[high]["start"])
        if finish - begin >= 1.0:
            spans.append((begin, finish))
    # 넓은 자리부터. 가장 크게 빈 곳이 타이밍을 가장 크게 어긋나게 한다.
    spans.sort(key=lambda span: span[0] - span[1])
    return spans


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
    """Every word the transcriber heard, in order, with the time it was heard at.

    여러 벌을 들었다면 그것들이 합의한 목록이 있다. 앵커는 그것으로 잡아야 한다 — 벌을 통째로
    섞은 목록은 정렬을 흔든다.
    """
    agreed = asr.get("consensus_words")
    if agreed:
        return list(agreed)
    words: list[dict[str, Any]] = []
    for segment in asr.get("segments") or []:
        for word in segment.get("words") or []:
            text = comparable(str(word.get("word", word.get("text", ""))))
            if not text or "start" not in word or "end" not in word:
                continue
            words.append({"text": text, "start": float(word["start"]), "end": float(word["end"])})
    return believable_times(words)


# 사람이 낼 수 있는 가장 빠른 말의 속도. 이보다 빠른 자리는 노래가 아니라 받아쓰기가 시각을
# 뭉갠 것이다.
#
# 잔나비 「주저하는 연인들을 위해」의 "추억할 그 밤 위에 갈피를 꽂고선" 은 여섯 낱말 열세
# 음절이 0.54 초 안에 앵커됐다 — 초당 스물넷이다. 앵커가 줄의 창을 정하고 정렬기는 창 밖으로
# 나갈 수 없으므로, 여섯 낱말이 반 초에 갇혔다. 화면에서는 그 줄만 순식간에 지나간다.
#
# 캐시해 둔 144 곡에서 이어진 낱말 다섯의 속도를 4 만 6 천 번 재니 가운뎃값이 3.9, 열에 아홉이
# 7.1 아래였고, 꼬리는 50.0 에 딱 붙어 멈춘다 — 받아쓰기가 20ms 격자에 시각을 몰아넣은 자리다.
# 천장을 10 에 두면 그런 자리의 96%(82 곳 → 3 곳)가 사라지고 앵커 밀도는 77.7% 에서 76.0% 로
# 1.7%p 만 준다. 8 까지 조이면 진짜 빠른 랩이 잘려 밀도가 71.2% 로 무너진다.
FASTEST_SYLLABLES = float(os.getenv("MORA_FASTEST_SYLLABLES", "10"))
PACE_RUN = 5


def believable_times(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """시각을 믿을 수 있는 낱말만.

    낱말 하나만 보면 짧은 조사가 늘 빨라 뜻이 없으므로, 이어진 다섯을 묶어 그 묶음의 음절
    속도를 본다. 넘는 묶음의 낱말은 시각이 증거가 되지 못한다 — 들린 것은 맞지만 언제
    들렸는지는 모르는 것이므로, 그 자리는 이웃 사이에 비례로 놓인다. 모르는 것을 모른다고
    두는 편이, 아는 척하며 반 초에 여섯 낱말을 쌓는 것보다 낫다.
    """
    if len(words) < PACE_RUN or FASTEST_SYLLABLES <= 0:
        return words
    doubted = [False] * len(words)
    for start in range(len(words) - PACE_RUN + 1):
        run = words[start : start + PACE_RUN]
        span = float(run[-1]["end"]) - float(run[0]["start"])
        beats = sum(syllables(str(word["text"])) for word in run)
        if span > 0 and beats / span > FASTEST_SYLLABLES:
            for index in range(start, start + PACE_RUN):
                doubted[index] = True
    kept = [word for index, word in enumerate(words) if not doubted[index]]
    if len(kept) != len(words):
        print(f"[hear] 사람이 낼 수 없는 속도로 찍힌 낱말 {len(words) - len(kept)}개는 시각을 믿지 않는다", file=sys.stderr)
    return kept


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


def bracket_mask(line: str, spans: list[list[int]] | None = None) -> list[bool]:
    """
    Which written words of the line are a bracketed aside — the second voice.

    "(꺼져)", "(나 너 싫으니까 꺼지라고)" are sung over the words beside them, not after them.
    Counted as ordinary words they are given a stretch of the song of their own, and the
    stretch comes out of their neighbours: on the measured song the aside took 1.3 seconds
    at the end of its line, the six words it was shouted over were squeezed into the 0.9
    before it, and the next line was pushed half a second late.

    A word is inside when the brackets around it are open, whether they opened on this word
    or an earlier one. Brackets holding no letters are punctuation, not a voice.

    spans 는 낱말이 줄의 어디에 놓였는지다. 워커가 가른 낱말은 구두점이 떨어져 나가 있어
    — "(꺼져)" 가 "꺼져" 로 온다 — 낱말만 보아서는 괄호를 알 수 없다. 자리를 받으면 줄을
    한 번 훑어 괄호 깊이를 세고 각 낱말이 어느 깊이에 있었는지 본다. 자리가 없으면(옛 워커)
    예전처럼 공백으로 가른다.
    """
    if spans is None:
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

    points = list(line)
    # 글자마다, 그 글자를 읽기 전의 괄호 깊이.
    depth_at: list[int] = []
    depth = 0
    for character in points:
        depth_at.append(depth)
        if character in BRACKETS:
            depth += 1
        elif character in BRACKETS.values() and depth > 0:
            depth -= 1
    depth_at.append(depth)

    out: list[bool] = []
    for begin, finish in spans:
        begin = max(0, min(begin, len(points)))
        finish = max(begin, min(finish, len(points)))
        # 낱말이 시작하는 자리의 깊이, 또는 낱말 안에서 괄호가 열렸다면 그것도 안이다.
        inside = depth_at[begin] > 0 or any(points[k] in BRACKETS for k in range(begin, finish))
        word = "".join(points[begin:finish])
        out.append(inside and re.search(r"[^\W_]", word, re.UNICODE) is not None)
    return out


def is_backing_line(line: str) -> bool:
    """A line that is nothing but a bracketed aside, so it has no voice of its own to time."""
    mask = bracket_mask(line)
    return len(mask) > 0 and all(mask)


# 앵커 바깥으로 되짚거나 나아갈 때 한 낱말에 주는 시간. 밖에는 증언이 없으니 노래가 대체로
# 이만큼씩 흘러간다는 어림일 뿐이다. 머리와 꼬리가 같은 값을 써야 양끝이 같은 밀도로 벌어진다.
WORD_PACE = 0.35


def anchored_windows(
    counts: list[int],
    words: list[str],
    heard: list[dict[str, Any]],
    start: float,
    end: float,
    floor: float | None = None,
    ceiling: float | None = None,
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
    # counts 는 토크나이저가 센 토큰이고 words 는 공백으로 자른 낱말이다. 아래에서 cursor 는
    # counts 로 걸으면서 positions 를 words 로 읽으므로, 둘의 합이 다르면 서로 다른 자로 잰
    # 자리를 짚는다. 일본어에는 띄어쓰기가 없어 한 줄이 통째로 한 낱말이 되므로 늘 어긋난다 —
    # 실측하면 첫 줄이 곡 전체를 삼키고 나머지 줄이 모두 곡 끝의 300ms 창으로 뭉친다. 지금껏
    # 드러나지 않은 것은 일본어가 앵커 문턱을 넘지 못해 여기까지 오지 못했기 때문이다.
    # 짐작으로 돌아가는 것이 틀린 자리를 확신하는 것보다 낫다.
    if sum(counts) != len(words):
        print(f"[align] 토큰 {sum(counts)}개와 낱말 {len(words)}개가 어긋난다 — 창을 짓지 않는다", file=sys.stderr)
        return None
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
        placed = anchored_windows(voiced_counts, voiced, heard, start, end, floor, ceiling)
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
            # 마지막 앵커 뒤의 줄들 — 머리를 뒤집은 것이다. 남은 낱말을 모두 마지막 앵커의 끝에
            # 몰아넣던 때에는 아래 300ms 하한과 맞물려 그 뒤의 줄이 전부 똑같은 창 하나로 겹쳤다.
            # 천장을 end 로 두면 소용이 없다: 받아쓰기가 아웃트로에서 멈추면 end 도 함께 앞당겨져
            # 마지막 앵커에 붙으므로, 꼬리를 만든 바로 그 절단이 천장까지 끌어당긴다.
            roof = (end if ceiling is None else ceiling) - 0.3
            reach = anchors[before[-1]]["end"] + (index - before[-1]) * WORD_PACE
            positions.append(min(roof, reach))
        elif after:
            # 첫 앵커보다 앞선 줄들. 한 낱말당 WORD_PACE 만큼 되짚어 가되, 소리가 시작하기
            # 전으로는 가지 않는다 — 바닥이 "가사가 처음 들린 곳"이면 이 줄들이 그 지점에 뭉개진다.
            reach = anchors[after[0]]["start"] - (after[0] - index) * WORD_PACE
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
        # 앵커가 남아 있는 줄은 지금까지처럼 end 로 자른다. 마지막 앵커보다 뒤에서 시작하는
        # 줄만 ceiling 으로 자른다 — end 는 받아쓰기가 멈춘 자리라, 꼬리를 만든 바로 그 절단이
        # 천장까지 함께 끌어당겨 내다본 줄을 도로 300ms 로 누른다. 증언이 남은 줄까지 넓히면
        # 마지막 앵커를 담은 줄이 아웃트로 위로 몇 초씩 늘어난다 — 실측 1650ms → 4450ms.
        bound = (end if ceiling is None else ceiling) if first > known[-1] else end
        # 구간의 끝으로 자르되 시작보다 이르게 두지 않는다 — 마지막 줄이 끝을 넘겨 시작하면
        # 시작이 끝보다 늦은 창이 나오고, 그런 창 안에서는 정렬기가 아무것도 할 수 없다.
        closed = max(min(bound, max(line_end, opened + 0.3)), opened + 0.3)
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


def variant_lines(variant: dict[str, Any]) -> tuple[list[str], list[list[str]], list[list[list[int]] | None]]:
    """가사의 줄과, 줄마다의 낱말과, 그 낱말이 줄의 어디에 놓였는지. 자르는 일은 이쪽에서 하지 않는다.

    낱말을 여기서 line.split() 으로 가르면 워커가 tokenizeV2 로 가른 것과 달라진다. 영어와
    한국어는 둘이 같지만 일본어는 띄어쓰기가 없어 한 줄이 통째로 낱말 하나가 되고 — 「出来る
    だけ嘘は無いように」한 줄이 저쪽에서는 여섯 낱말이다 — 그 어긋남은 두 곳에서 값을 치른다.
    앵커를 줄 단위로만 잡게 되어 정렬이 거칠어지고, 낱말마다 매기는 번호가 word_spans 를 읽는
    쪽이 기대하는 토큰 번호와 달라진다.

    줄 목록도 마찬가지다. 여기서는 빈 줄만 걸렀고 저쪽은 「[Verse 1]」 같은 머리글도 걸렀으므로,
    머리글이 있는 가사에서는 줄 수가 맞지 않았다. 그러면 예전 코드는 token_counts 를 버리고
    split() 로 물러났는데, 그 순간 번호 체계가 통째로 어긋난다 — 일본어만의 이야기가 아니다.

    그래서 잘라 놓은 것을 그대로 받아 쓴다. 없으면 (옛 워커) 예전처럼 가른다.
    """
    supplied = variant.get("token_lines")
    if isinstance(supplied, list) and supplied:
        lines = [str(item.get("text", "")) for item in supplied]
        words = [[str(word) for word in item.get("words", [])] for item in supplied]
        spans = [[[int(a), int(b)] for a, b in item.get("spans", [])] or None for item in supplied]
        return lines, words, spans
    lines = [line for line in str(variant.get("text", "")).splitlines() if line.strip()]
    return lines, [line.split() for line in lines], [None] * len(lines)


def token_weights(line_words: list[list[str]], counts: list[int]) -> list[float]:
    """토큰마다 몇 음절어치 시간을 받을 자격이 있는지.

    예전에는 줄을 여기서 다시 갈라 그 수가 counts 와 맞을 때만 음절을 셌다. 일본어는 한 줄이
    통째로 낱말 하나로 갈려 한 번도 맞은 적이 없고, 그래서 모든 토큰이 똑같이 1.0 을 받았다 —
    한 글자짜리 조사와 네 음절 낱말이 같은 시간을 나눠 가졌다는 뜻이다. 이제 갈라 놓은 것을
    받으므로 그 자리가 없다."""
    weights: list[float] = []
    for line_index, count in enumerate(counts):
        written = line_words[line_index] if line_index < len(line_words) else []
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
    text_lines, line_words, line_spans_at = variant_lines(variant)
    counts = [len(words) for words in line_words]
    # Where the transcriber actually heard these words beats dividing the song by word count.
    lyric_words = [comparable(word) for words in line_words for word in words if comparable(word)]
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
        # 천장은 파일의 길이지 소리가 멎는 자리가 아니다. 받아쓰기가 멈춘 end 를 쓰면 꼬리를
        # 만든 절단이 천장까지 끌어당기므로 그것보다는 낫지만, 뒤에 박수나 아웃트로가 붙은
        # 음원에서는 마지막 줄들이 부르지 않은 구간 위에 놓일 수 있다. 소리가 실제로 멎는
        # 자리를 포락선에서 구하는 편이 옳고, 그것은 아직 재어 보지 않았다.
        ceiling=duration_ms / 1000.0,
        backing=[
            flag
            for index, line in enumerate(text_lines)
            for word, flag in zip(line_words[index], bracket_mask(line, line_spans_at[index]))
            if comparable(word)
        ],
    )
    # When was each line's first word heard — the counter-witness against leading noise.
    anchors = match_sequences(lyric_words, heard_words)
    # 증언이 얼마나 촘촘한가. 앵커를 낱말 번호로 세어 가장 넓게 빈 자리를 잰다 — 양끝도
    # 빈 자리다. 첫 앵커 앞과 마지막 앵커 뒤는 되짚거나 내다본 것이지 들은 것이 아니다.
    anchored_at = sorted(anchors)
    widest_anchor_gap = 0
    if anchored_at:
        edges = [-1, *anchored_at, len(lyric_words)]
        widest_anchor_gap = max(edges[i + 1] - edges[i] - 1 for i in range(len(edges) - 1))
    else:
        widest_anchor_gap = len(lyric_words)
    line_start_witness_ms: dict[int, float] = {}
    # 그리고 낱말마다: 받아쓰기가 그 낱말을 들은 시각. 줄 안에서 경계를 다시 긋는 데 쓴다.
    witness_ms: dict[int, float] = {}
    word_offset = 0
    token_offset = 0
    for line_index, line in enumerate(text_lines):
        written = line_words[line_index]
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
    # 아래 try 는 이 목록을 줄마다 덮어쓴다. anchored 를 그대로 받으면 그것이 파괴되고,
    # 중간에 예외가 나면 except 는 반쯤 갱신된 창과 전혀 다른 좌표계의 fallback_words 를
    # 함께 내보낸다 — 줄과 낱말이 몇 초씩 어긋난 채로. 앵커가 늘 None 이던 동안에는 이
    # 가지가 언제나 새 사본이라 드러나지 않았다.
    line_windows = [span[:] for span in (anchored or proportional_windows)]
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
                for position, word in enumerate(line_words[line_index])
                if comparable(word) and not any(character in alphabet for character in comparable(word))
            ]
            if spots:
                illegible[line_index] = spots
        borrowed_lines: dict[int, dict[int, tuple[float, float]]] = {}
        if illegible and mms_ready():
            voice = mms_voice(vocals)
            if voice is not None:
                for line_index in illegible:
                    borrowed_lines[line_index] = mms_line_spans(voice, line_windows[line_index], line_words[line_index])
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
                result_words.extend(spread_in_window(line_windows[line_index], token_index, count, token_weights(line_words, counts)))
            token_index += count
            last_token_of_line[token_index - 1] = line_index
        snap_line_starts(result_words, line_windows, counts, line_start_witness_ms)
        extend_held_endings(result_words, line_windows, last_token_of_line, heard_words)
        snap_words_to_witness(result_words, counts, witness_ms)
        weights = token_weights(line_words, counts)
        spread_crushed_words(result_words, line_windows, counts, weights)
        # 겹쳐 부른 말은 옆에 적혀 있을 뿐 뒤에 부른 것이 아니다. 들린 자리가 있으면 그리로.
        place_backing_runs(result_words, counts, text_lines, weights, second_voice or [])
        close_lines_over_words(result_words, line_windows, counts)
        coverage = aligned_token_weight / max(1, sum(counts))
        # 창을 다 옮기고 난 마지막 자리에서 잰다 — 이 위의 손질들이 경계를 움직이기 때문이다.
        # 받아쓰기가 이미 16 kHz 로 읽어 둔 것을 다시 쓴다. 파일을 두 번 열 이유가 없다.
        breathing, gaps_seen = breath_gaps(audio, WHISPER_SAMPLE_RATE, line_windows)
        quality = measure(result_words, line_windows, coverage, duration_ms, anchored_by_asr, declared, detected,
                          anchors=len(anchors), lyric_words=len(lyric_words), widest_gap=widest_anchor_gap,
                          breathing=breathing)
        print(f"[breath] {breathing:.0%} of {gaps_seen} line gap(s) land on a breath", file=sys.stderr)
        if borrowed_words:
            print(f"[mms] borrowed {borrowed_words} word(s) the {language} aligner has no letters for", file=sys.stderr)
        return {"variant_id": variant["id"], "line_spans": line_windows, "word_spans": result_words, "quality": quality}
    except Exception as error:
        print(f"[forced_align] fallback error={type(error).__name__}", file=sys.stderr)
        # 여기 오는 창은 비례로 나눈 짐작이다. 그래도 재어 둔다 — 짐작이 얼마나 빗나가는지가
        # 잣대를 놓을 때의 대조군이 되고, 실측에서 정말 갈라졌다.
        breathing = 1.0
        try:
            import soundfile
            heard, rate = soundfile.read(str(vocals), dtype="float32", always_2d=True)
            breathing, _ = breath_gaps(heard.mean(axis=1), int(rate), line_windows)
        except Exception:
            pass
        quality = measure(fallback_words, line_windows, 0.0, duration_ms, False,
                          str(variant.get("language", "und")).split("-")[0], detected,
                          anchors=0, lyric_words=len(lyric_words), widest_gap=len(lyric_words),
                          breathing=breathing)
        return {"variant_id": variant["id"], "line_spans": line_windows, "word_spans": fallback_words, "quality": quality}


# 줄 사이가 양옆보다 이만큼 내려앉으면 숨 쉬는 자리로 본다. 사람이 한 소절을 맺고 숨을
# 들이켜면 대개 10 dB 넘게 떨어진다. 8 로 둔 것은 잔향이 긴 곡에 여유를 준 것이다.
BREATH_DROP_DB = 8.0
BREATH_FRAME = 0.02
# 이보다 짧은 틈은 재지 않는다. 20 ms 단위로 재는데 0.2 초면 열 칸이라, 더 짧으면 바닥값이
# 한두 칸에 좌우된다.
BREATH_GAP_SECONDS = 0.2
# 잴 틈이 이보다 적으면 이 잣대는 할 말이 없다. 없는 근거로 곡을 막지 않는다.
ENOUGH_BREATH_GAPS = 4
# whisperx.load_audio 가 내놓는 것. 이 값은 whisper 모델이 요구하는 것이라 바뀌지 않는다.
WHISPER_SAMPLE_RATE = 16000


def breath_gaps(samples: Any, rate: int, lines: list[list[int]]) -> tuple[float, int]:
    """
    줄의 경계가 숨 쉬는 자리에 떨어지는가.

    앵커 밀도는 "몇 낱말이 실제로 들려서 자리를 잡았나" 를 말할 뿐, 그 자리가 맞는지는 말하지
    않는다. 보컬이 내내 차 있는 곡에서는 스물일곱 줄을 아무렇게나 늘어놓아도 전부 노래 위에
    있다. 가리는 것은 줄과 줄 **사이**다 — 경계가 맞으면 그 틈은 숨 쉬는 자리라 양옆보다
    뚜렷이 내려앉고, 밀렸으면 노래 한가운데라 내려앉지 않는다.

    절대 문턱으로는 안 된다. 실측에서 -50 dB 를 문턱으로 두었더니 전주(1%)와 후주(5%)는
    갈라냈지만 줄 사이 스물여섯 개가 모두 "노래 중" 으로 나왔다 — 스템에는 잔향과 숨이 남아
    그 정도는 넘긴다. 그래서 절대값을 버리고 주변 대비 얼마나 내려앉는지만 본다.

    양옆은 틈에 붙은 1.5 초씩만 본다. 줄 전체를 재면 먼 데의 셈여림이 섞인다. 틈은 가운뎃값이
    아니라 가장 조용했던 순간으로 본다 — 숨은 짧아서 가운뎃값에 묻힌다.
    """
    import numpy

    if rate <= 0 or len(samples) == 0 or len(lines) < 2:
        return 1.0, 0
    step = max(1, int(rate * BREATH_FRAME))
    block = samples[: len(samples) // step * step].reshape(-1, step)
    if len(block) == 0:
        return 1.0, 0
    power = numpy.sqrt(numpy.mean(numpy.square(block, dtype=numpy.float64), axis=1))
    loud = 20.0 * numpy.log10(numpy.maximum(power, 1e-10))

    def window(begin: float, end: float) -> Any:
        first = max(0, int(begin / BREATH_FRAME))
        last = max(first + 1, int(end / BREATH_FRAME))
        return loud[first:last]

    breathed, counted = 0, 0
    for index in range(len(lines) - 1):
        begin, end = int(lines[index][1]) / 1000.0, int(lines[index + 1][0]) / 1000.0
        if end - begin < BREATH_GAP_SECONDS:
            continue
        before = window(max(int(lines[index][0]) / 1000.0, begin - 1.5), begin)
        after = window(end, min(int(lines[index + 1][1]) / 1000.0, end + 1.5))
        gap = window(begin, end)
        if len(before) == 0 or len(after) == 0 or len(gap) == 0:
            continue
        around = max(float(numpy.median(before)), float(numpy.median(after)))
        counted += 1
        if around - float(numpy.min(gap)) >= BREATH_DROP_DB:
            breathed += 1
    if counted < ENOUGH_BREATH_GAPS:
        return 1.0, counted
    return breathed / counted, counted


def measure(
    words: list[list[int | float]],
    lines: list[list[int]],
    coverage: float,
    duration_ms: int,
    anchored: bool,
    language: str = "und",
    detected: str = "und",
    anchors: int = 0,
    lyric_words: int = 0,
    widest_gap: int = 0,
    breathing: float = 1.0,
) -> dict[str, float]:
    """
    What the alignment is actually worth.

    monotonicity, duration_match and language_match used to be the literal 1.0, so every
    candidate scored a perfect 1.000 and the quality gate could never fail — including the
    ones whose timings were a proportional guess. They are measured now.

    anchored 는 문턱을 넘었는가만 말한다. 문턱은 낱말 수의 1/12 이라 366 낱말짜리 곡은 30 개
    로 통과하는데, 코르티스 「REDRED」는 69 개가 붙어 넉넉히 통과하고도 낱말의 81% 는 앵커
    없이 보간으로 채워졌다 — 앵커가 52 낱말 연속으로 비는 자리가 있었고 곡의 81~97 초에는
    하나도 없었다. 오토튠이 음소를 뭉개 받아쓰기가 "kickin in" 을 "키기니" 로 들은 탓이다.
    창 안에서 정렬기가 놓은 자리는 모두 실측으로 적히므로, 창 자체가 짐작이었다는 사실은
    개수만 보아서는 어디에도 남지 않는다. 그 바깥층을 여기서 적는다.
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
        # 낱말 몇에 하나꼴로 실제 증언이 있는가. 문턱을 넘었는지가 아니라 얼마나 촘촘한지다.
        "anchor_density": min(1.0, anchors / lyric_words) if lyric_words > 0 else 0.0,
        # 증언 없이 이어 간 가장 긴 구간. 여기가 길수록 그 사이는 균등히 나눈 짐작이다.
        # 낱말 수로 재고 1.0 을 상한으로 둔다 — 40 낱말이 비면 이미 줄 여럿이 통째로 짐작이다.
        "anchor_reach": max(0.0, 1.0 - widest_gap / 40.0) if lyric_words > 0 else 0.0,
        # 줄의 경계가 숨 쉬는 자리에 떨어진 비율. 앵커가 말하지 않는 "그 자리가 맞는가" 를 잰다.
        "breath_gaps": breathing,
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
    # 앞선 시도가 남긴 파일은 그대로 쓴다 — 다시 받는 것은 비싸다. 다만 그것이 이 곡이
    # 맞는지는 확인하고 쓴다. 잘못 받아 둔 것을 물려받으면 재시도가 몇 번이든 같은 결과다.
    source = downloaded(directory)
    if source is not None and wrong_length(source, job) is not None:
        source.unlink(missing_ok=True)
        source = None
    source = source or download(job, directory, params.get("cookie_file"), params.get("proxy"))
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
    # 가사의 낱말을 먼저 갖춰 두어야 어디가 비었는지 알 수 있다. 변형이 여럿이면 가장 긴
    # 것을 쓴다 — 짧은 변형에서 비지 않은 자리도 긴 변형에서는 빌 수 있다.
    heard_target = max(
        ([comparable(word) for words in variant_lines(variant)[1] for word in words if comparable(word)]
         for variant in job.get("lyrics", [])),
        key=len,
        default=[],
    )
    asr, detected = hear_everything(stems["vocals"], expected_language(job), config["backend"], heard_target)
    asr = redo_invented_segments(asr, "\n".join(str(variant.get("text", "")) for variant in job.get("lyrics", [])), stems["vocals"], config["backend"])
    notify("coarse_asr", "completed", 0.64)
    # 리드 위에 겹쳐 부른 목소리는 받아쓰기에 한 글자도 남지 않는다. 읽을 수는 없어도
    # 들린 자리는 잴 수 있고, 괄호로 적힌 가사는 그 자리에 놓는다.
    second_voice: list[tuple[float, float]] = []
    if os.getenv("MORA_SPLIT_VOICES", "1") != "0":
        notify("split_voices", "started", 0.645)
        split = split_voices(stems["vocals"], directory)
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
        # 코드를 두 번 보내던 자리다. 무엇이 왜 안 됐는지는 detail 에 있는데 그것을 버리면,
        # 받는 쪽에는 토큰 하나만 남아 IP 차단과 쿠키 만료와 비공개 영상이 같아 보인다.
        said = getattr(error, "detail", None)
        message = said if isinstance(said, str) and said.strip() else code
        payload = {"jsonrpc": "2.0", "id": identifier, "error": {"code": code, "message": message}}
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
