#!/usr/bin/env python3
"""
Fit known lyrics to the sound — forced alignment.

Nobody places a hundred words by hand from scratch. Today they are laid out by character
count, which is only a "plausible" position, not one chosen by listening. Running a model
once to get roughly right and letting a human fix only what is wrong is the better trade.

No transcription is needed. We already know what is being sung, so all that is required is
to **fit known characters to the sound**. The Galaxy Book has no NVIDIA card but does carry
an Intel Arc, so this runs on `torch.xpu` — CPU works too, but this is also the slot where
bigger models will run later.

The **whole song is aligned at once**. The first version cut each line down to its own
window, but line times mark only the **start**, so wherever the window end was placed it was
wrong. When the window ends before the singing does, the remaining characters are crammed
into the last few frames 0.02 s apart — the `테·니·까` of 「남겨질테니까」 came out as
29.60·29.62·29.64. Widening the window only moves that spot elsewhere.

CTC alignment searches for the path that is **most likely as a whole** for the given token
sequence. One ambiguous spot is not pushed forward into the rest, so removing walls beats
building them well.

Caution — what comes out is **a starting point, not the answer**. Left as is and marked
"correct", our model's mistakes become ground truth, and then our own model is scored
against that ground truth. A human has to actually fix it.
"""
from __future__ import annotations

import re
import subprocess
import unicodedata
from pathlib import Path

#: Sample rate the forced aligner is fed at (Hz).
SAMPLE_RATE = 16_000
#: Shortest span a single word may hold (ms). Anything shorter cannot be grabbed on screen.
LEAST_MS = 60
#: Longest a single character is ever held (ms). Ballads hold a final note for 1~2 s often
#: enough, but gluing the instrumental break that follows onto it makes one character swell
#: across several seconds of screen.
HOLD_MS = 1500
#: Threshold (nat) for trimming the tail. A frame that falls this far short of its most
#: likely character is read as "merely attached here, not actually heard".
SUPPORT = 2.5
#: How much worse than the model's own pick at that frame a character may be before it is
#: flagged (nat).
#:
#: It was 3 at first and caught 141 of 252 (56%). Flagging that many defeats the purpose.
#:
#: This value never measured **whether the time is right** in the first place. It asks "is
#: the model's top pick the same as this character", and a 1207-way classifier asked about
#: singing is wrong more than half the time as a matter of course — which does not mean the
#: time is wrong. Measured against Vibe, the median error of line starts is 15 ms.
#:
#: So it is not a yardstick but **a way to draw the eye**, tightened so that only badly wrong
#: spots get pointed out. The thing to actually measure is "compare line starts against the
#: outside times" further below.
DOUBT = -8.0
#: How far the CTC peak lands after the syllable's onset (ms); three songs gave
#: +0.18·+0.22·+0.25. Walking back to the onset goes at most twelve frames (20 ms each) —
#: twelve frames is 0.24 s, and no Hangul syllable takes longer than that to start.
ONSET_LEAD_MS = 200
#: Characters packed tighter than this are faster than a human can produce (ms). Twelve
#: syllables a second is the limit.
CRAMP_MS = 80
#: Lines off by more than this from the outside line time are re-examined (ms), measured
#: after the song-wide bias has been subtracted.
SUSPECT_MS = 500
#: How much better the per-token score must be before a re-examined line is **actually moved**.
#:
#: Not an arbitrary number. Badly-off lines were aligned at both candidate positions (the one
#: we chose / the one from outside) and the scores compared:
#:
#:   we were wrong       「그럼에도 불구하고」 +2.07 · 「이젠 안될거같아」 +0.65 · If I cared +0.42
#:   outside was wrong   파란달팽이 47·48 −2.75 −6.01 · Small girl 60·61·62 −2.08 −4.26 −5.86
#:
#: The two groups overlap around ±0.5, so only **clear cases** are moved — at 1.0
#: 「그럼에도 불구하고」 moves and the ambiguous ones stay put. Fixing only what can be fixed
#: beats wrecking songs 6 and 7 by 14 s each while chasing the ambiguous ones.
EVIDENCE = 1.0
#: How much room to open on each side when re-examining (ms), so a slightly wrong line time
#: still falls inside the window.
LOOK_MS = 1500
#: A line this many times longer or shorter than another take of the same text counts as
#: collapsed. Measured, collapsed lines ran 3~4x (0.88 s against 10.23 s) while healthy
#: repeats stayed within 1.3x.
STRETCH = 1.8
#: A gap this wide between characters inside one line means the alignment got lost somewhere
#: in between (ms). Singing rarely pauses 2 s within a single line.
STUCK_HOLE_MS = 2000
#: How much better per token the backing stem must score before a line is taken as backing.
#:
#: Deliberately biased one way. The lead carries most of the song, and sending a lead line to
#: the backing stem aligns it over near-silence and goes badly wrong. The reverse — leaving a
#: backing line on the lead — merely reproduces the status quo and makes nothing worse. Put
#: the threshold on the side with less to lose.
VOICE_EDGE = 0.5
#: How far a line rescued from the backing stem may stray from where the lead placed it (ms)
#: before it is distrusted. Aligning only a few lines lets a repeated phrase land anywhere in
#: the song.
RESCUE_REACH_MS = 4000

#: Stems we **produced** from the source. They sit beside the source under the same stem name,
#: so they have to be filtered out when picking the source.
MADE_FROM = (".vocals.wav", ".lead.wav", ".back.wav")


def source_in(folder: Path, video_id: str) -> Path | None:
    """Find the **original** audio of a song, filtering out everything we produced.

    This one line was copied around, and **the same trap was stepped on twice.** First the
    server picked `sorted(glob)[0]` and grabbed `{id}.back.wav` as the source, so both playback
    and alignment ran on audio that held nothing but backing vocals; after that was fixed the
    probes were still filtering only `.vocals.wav` and got it wrong the same way. Reading those
    wrong values as "the whole song is 20 s late" nearly led to reverting healthy code.

    **There must be exactly one place that picks the file.** When the side that measures and the
    side that uses pick files by different routes, a disagreement in the numbers has no findable
    cause.

    @param {Path} folder - Directory holding the song's files.
    @param {str} video_id - Stem name shared by every file of that song.
    @returns {Path | None} The original audio file, or None when nothing matches.
    """
    found = sorted(p for p in folder.glob(f"{video_id}.*")
                   if p.suffix != ".part" and not p.name.endswith(MADE_FROM))
    return found[0] if found else None


#: Process-wide cache for everything expensive to build: the model, the vocabulary table, the
#: romaniser, the speaker encoder and the romanisation memo.
_bundle: dict = {}


def device():
    """Pick the fastest backend available.

    The Galaxy Book carries an Intel Arc, reached through `torch.xpu`. A missing CUDA is no
    reason to fall back to CPU — the integrated GPU still beats the CPU by a wide margin, and
    the same slot is used later when bigger models run.

    @returns {str} One of "xpu", "cuda" or "cpu".
    """
    import torch
    if hasattr(torch, "xpu") and torch.xpu.is_available():
        return "xpu"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def load():
    """Load the alignment model once and hand back the cached copy.

    The model is 1.2 GB, so loading it per song would take most of the runtime.

    The bundle is torchaudio's MMS_FA, a multilingual model built purely for forced alignment.
    The first version used a Korean ASR model (`kresnik/wav2vec2-large-xlsr-korean`); its
    vocabulary was Hangul, so there was no romanisation step to worry about, but it was trained
    on read speech and kept losing its way in singing. Measured on three songs with the same
    yardstick the difference is plain, especially on repeat-heavy rap songs:

      song                  Korean model                  MMS_FA
      사랑하게 될거야        78 ms · 6 lines over 0.3 s     65 ms · 5 lines
      미안하다는말           15 ms · 1 line                 32 ms · 0 lines
      Trip                  52 ms · **21 lines**           29 ms · **1 line**

    MMS_FA was built **to align** in the first place and learned over a thousand languages
    together. Its vocabulary is only twenty-nine Latin letters, so Hangul has to be romanised
    on the way in (uroman) — and thanks to that, "characters outside the vocabulary" disappear
    entirely; spots like 「괜」 that used to be unattachable as a whole word are gone.

    @returns {tuple[dict, object]} The vocabulary table and the loaded model.
    """
    if not _bundle:
        import torch
        import torchaudio
        import uroman
        torch.set_num_threads(8)
        where = device()
        bundle = torchaudio.pipelines.MMS_FA
        _bundle["where"] = where
        _bundle["table"] = bundle.get_dict()
        _bundle["roman"] = uroman.Uroman()
        _bundle["model"] = bundle.get_model().eval().to(where)
    return _bundle["table"], _bundle["model"]


def grains_of(word: str) -> list[str]:
    """Split a word into the grains that get timed.

    Hangul goes one syllable at a time; Latin letters and digits stay glued together for as long
    as they run. **This must follow the same rule as `grainsOf` on the front end.** If the two
    sides split differently, the character indices drift apart and a whole word fails to attach —
    a bug of exactly that family has already happened here (the tokenizer split of §2).

    @param {str} word - One word of lyric text.
    @returns {list[str]} The grains of that word, in order.
    """
    out: list[str] = []
    latin = ""
    for one in unicodedata.normalize("NFC", word):
        if "가" <= one <= "힣":
            if latin:
                out.append(latin)
                latin = ""
            out.append(one)
        elif one.isascii() and (one.isalnum() or one == "'"):
            latin += one
        elif latin:
            out.append(latin)
            latin = ""
    if latin:
        out.append(latin)
    return out


def letters(grain: str) -> list[int]:
    """Romanise one grain and turn it into vocabulary ids.

    MMS_FA's vocabulary is only twenty-nine Latin letters. 「괜」 becomes `gwaen`, five letters —
    one Hangul syllable turns into several tokens, but the first of them is where that character
    starts.

    The earlier version, on a Korean ASR model, had to drop characters missing from the
    vocabulary (「괜」 was one) and the whole word then failed to attach. Romanised, there is no
    character that cannot go in.

    Lyrics repeat the same character endlessly and romanisation runs in Python, so calling it
    hundreds of times per song would take a large share of the total time — each grain is
    romanised once and memoised.

    @param {str} grain - A single grain from `grains_of`.
    @returns {list[int]} Vocabulary ids for that grain; empty when nothing maps.
    """
    table, _ = load()
    memo = _bundle.setdefault("said", {})
    if grain not in memo:
        memo[grain] = _bundle["roman"].romanize_string(grain).lower()
    return [table[one] for one in memo[grain] if one in table]


def speakable(text: str) -> str:
    """Keep only what can actually be sung.

    Parenthesised stage directions and punctuation are not things to align against.

    @param {str} text - Raw lyric text.
    @returns {str} The text with bracketed spans and punctuation replaced by spaces.
    """
    text = re.sub(r"[\(（\[].*?[\)）\]]", " ", text)
    return re.sub(r"[^0-9A-Za-z가-힣\s]", " ", text)


def fill_gaps(chars: list[dict]) -> None:
    """Give out-of-vocabulary characters a place in time. Edits in place.

    A character the model does not know still has to show on screen, and it is still sung at its
    own spot in the song.

    The earlier version **piled every leading and trailing empty character onto the same instant**
    — `chars[i]["at"] = at of the first known character`. Words that begin with an
    out-of-vocabulary character, like 「홀업」, collapsed into a single moment and neighbouring
    characters ended up with identical times. That is a value nothing can be dragged from.

    So leading characters step **backwards** one slot at a time from the first known character,
    trailing ones step forwards from the end of the last known character, and interior runs divide
    their span evenly.

    @param {list[dict]} chars - Character dicts carrying "at"/"end", modified in place.
    @returns {None}
    """
    if not chars:
        return
    known = [i for i, one in enumerate(chars) if one["at"] is not None]
    if not known:
        return

    head = known[0]
    for step, i in enumerate(range(head - 1, -1, -1), start=1):
        at = chars[head]["at"] - CRAMP_MS * step
        chars[i]["at"] = at
        chars[i]["end"] = at + CRAMP_MS

    tail = known[-1]
    for step, i in enumerate(range(tail + 1, len(chars))):
        at = (chars[tail]["end"] or chars[tail]["at"]) + CRAMP_MS * step
        chars[i]["at"] = at
        chars[i]["end"] = at + CRAMP_MS

    for one, two in zip(known, known[1:]):
        holes = two - one - 1
        if holes <= 0:
            continue
        span = max(CRAMP_MS * (holes + 1), chars[two]["at"] - chars[one]["at"])
        each = span / (holes + 1)
        for step in range(1, holes + 1):
            at = int(chars[one]["at"] + each * step)
            chars[one + step]["at"] = at
            chars[one + step]["end"] = int(chars[one]["at"] + each * (step + 1))
        chars[one]["end"] = chars[one + 1]["at"]


def loosen_chars(chars: list[dict]) -> None:
    """Spread out spots packed tighter than a human can sing. Run **after every character has a
    time**. Edits in place.

    In a repeated phrase the alignment crams one of the takes into a narrow slot — the front half
    of 「잠깐이면 돼 잠깐이면」 came out 20 ms apart, fifty syllables a second, which no human
    produces. A number appearing is not the same as it being right, so it is at least widened to
    **a spacing that could be sung**. That passage is flagged as doubtful anyway and goes to a
    person.

    Only one forward pass is made. The earlier version looked for cramped clusters and spread them
    evenly inside themselves, and the spreading **ran over the next character's slot** so two
    characters shared one time. The push does ripple forward, but that beats an inverted or
    overlapping order.

    Ends are then run out **until the next character starts**. Leaving gaps makes a character flash
    on screen, stop, and wait for the next one — the song does not sound like that.

    @param {list[dict]} chars - Character dicts carrying "at"/"end", modified in place.
    @returns {None}
    """
    if any(one["at"] is None for one in chars):
        return
    for index in range(1, len(chars)):
        least = chars[index - 1]["at"] + CRAMP_MS
        if chars[index]["at"] < least:
            chars[index]["at"] = least
    for one, two in zip(chars, chars[1:]):
        one["end"] = max(one["at"] + 20, min(two["at"], one["at"] + HOLD_MS))
    if chars:
        last = chars[-1]
        last["end"] = max(last["end"] or 0, last["at"] + CRAMP_MS)


def whole_logits(audio):
    """Frame-wise log probabilities for the whole song, inferred in overlapping pieces and
    stitched back together.

    It cannot go in at once: wav2vec2's attention grows with the square of the length, so four
    minutes (twelve thousand frames) is more than memory can take. Instead the audio is cut into
    30 s pieces inferred with **2 s of extra context on each side**, and that context is thrown
    away — the edge of a piece has no surrounding context and its probabilities wobble.

    After stitching, alignment runs **exactly once**. The earlier version put a window on every
    line, and when a window's end was wrong the remaining characters piled into its last few frames
    0.02 s apart; that window is gone entirely.

    The audio is normalised the way the model expects (`do_normalize: True`). Raw audio was being
    fed in before — training-time and inference-time loudness differed, which blurs the
    probabilities across the board and was a large share of "mostly right but occasionally misses".
    Normalisation is done over the whole song at once; doing it per piece blows up the pieces that
    fall on quiet passages and makes the probabilities jump at the seams.

    Pieces are cut **on the frame grid**. wav2vec2 emits one frame per 320 samples (20 ms). The
    earlier version converted back per piece with `length / frame count` and rounded, and that
    error accumulated piece by piece until times drifted later and later through the song. Because
    the cuts are grid-aligned, the overlap converts straight into a frame count. Note that
    torchaudio's model returns a `(probabilities, lengths)` pair, unlike the `.logits` of the
    transformers build.

    @param {torch.Tensor} audio - `(channels, samples)` waveform at `SAMPLE_RATE`.
    @returns {torch.Tensor} Log-softmaxed `(1, frames, vocabulary)` probabilities.
    """
    import torch
    _, model = load()
    where = _bundle.get("where", "cpu")
    total = audio.shape[-1]

    voice = audio.to(torch.float32)
    voice = (voice - voice.mean()) / (voice.std() + 1e-7)

    stride = 320
    step = (30 * SAMPLE_RATE // stride) * stride
    edge = (2 * SAMPLE_RATE // stride) * stride

    pieces = []
    at = 0
    while at < total:
        stop = min(total, at + step)
        left = max(0, at - edge)
        right = min(total, stop + edge)
        with torch.inference_mode():
            got = model(voice[..., left:right].to(where))[0].cpu()
        head = (at - left) // stride
        tail = (right - stop) // stride
        pieces.append(got[:, head: got.shape[1] - tail if tail else None])
        at = stop
    return torch.log_softmax(torch.cat(pieces, dim=1), dim=-1)


def read_audio(path: Path, rate: int = SAMPLE_RATE, channels: int = 1):
    """Read any audio format at the requested sample rate and channel count.

    The default is the 16 kHz mono that forced alignment wants.

    `torchaudio.load` drops its own decoder from 2.11 on and calls torchcodec. Rather than install
    that too and match versions, this reads through the ffmpeg already present — which handles
    seeking and resampling in the same pass.

    The sample rate has to be selectable for a reason. **The separation models were trained on
    44.1 kHz stereo.** Fed a 16 kHz mono downmix, everything above 8 kHz is simply missing and
    there is no stereo image either, so they separate badly — that is what made lead and backing
    sound "badly broken up". Only alignment gets the 16 kHz downmix.

    ffmpeg hands channels back interleaved (L R L R …), so the samples are reshaped to give each
    channel its own row.

    @param {Path} path - Audio file to read.
    @param {int} [rate=SAMPLE_RATE] - Target sample rate in Hz.
    @param {int} [channels=1] - Target channel count.
    @returns {torch.Tensor} `(channels, samples)` float32 waveform.
    @throws {RuntimeError} When ffmpeg fails or returns nothing.
    """
    import numpy
    import torch
    got = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", str(path),
         "-f", "f32le", "-ac", str(channels), "-ar", str(rate), "-"],
        stdin=subprocess.DEVNULL, capture_output=True, timeout=600)
    if got.returncode != 0 or not got.stdout:
        raise RuntimeError(f"음원을 못 읽는다: {got.stderr.decode()[-200:]}")
    samples = numpy.frombuffer(got.stdout, dtype=numpy.float32).copy()
    return torch.from_numpy(samples).reshape(-1, channels).T.contiguous()


def write_audio(wave, path: Path, rate: int) -> None:
    """Write a `(channels, samples)` waveform out as a wav file.

    Kept at 24 bit — the stems get separated again downstream, so headroom is left in place.

    @param {torch.Tensor} wave - `(channels, samples)` waveform.
    @param {Path} path - Destination file.
    @param {int} rate - Sample rate to write at, in Hz.
    @returns {None}
    @throws {RuntimeError} When ffmpeg fails to write the file.
    """
    import numpy
    flat = wave.T.contiguous().numpy().astype(numpy.float32)
    got = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-y",
         "-f", "f32le", "-ar", str(rate), "-ac", str(wave.shape[0]), "-i", "-",
         "-c:a", "pcm_s24le", str(path)],
        input=flat.tobytes(), capture_output=True, timeout=600)
    if got.returncode != 0:
        raise RuntimeError(f"소리를 못 남긴다: {got.stderr.decode()[-200:]}")


def cut_apart(source: Path, model: str, want: str, into: Path) -> Path | None:
    """Pull one stem out with `audio-separator` and save it to `into` at full quality.

    Two callers (pulling vocals, splitting lead from backing) do the same work, so it lives in one
    place. Writing the same job twice in this repository has already let the two copies drift
    apart more than once.

    **It has to run on XPU/CUDA.** audio-separator only looks for cuda, mps and directml, so it
    misses the Arc and falls back to CPU, where a four-minute song takes 20 minutes and is
    unusable.

    audio-separator reads through soundfile and **cannot open m4a**, so anything that is not
    already wav is decoded to wav first. That temporary wav is **rewritten even when it already
    exists**: a previous run that died mid-way leaves a truncated file, and trusting it as a cache
    blows up somewhere else entirely with `LibsndfileError: System error`. Re-decoding costs a few
    seconds, which is not worth saving.

    @param {Path} source - Audio to separate.
    @param {str} model - `audio-separator` model filename.
    @param {str} want - Fragment to look for in the produced names (`(Vocals)` · `(Instrumental)`).
    @param {Path} into - Where the wanted stem is written.
    @returns {Path | None} `into` when the stem was produced, otherwise None.
    """
    import torch
    from audio_separator.separator import Separator

    into.parent.mkdir(exist_ok=True, parents=True)
    work = into.parent / "split"
    work.mkdir(exist_ok=True)

    fed = source
    raw = None
    if source.suffix.lower() != ".wav":
        raw = work / f"{source.stem}.src.wav"
        write_audio(read_audio(source, rate=44100, channels=2), raw, 44100)
        fed = raw

    apart = Separator(output_dir=str(work), output_format="WAV", log_level=40)
    apart.torch_device = torch.device(device())
    apart.load_model(model_filename=model)
    made = apart.separate(str(fed))

    got = None
    for name in made:
        one = work / name
        if not one.exists():
            continue
        if want in name:
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(one),
                            "-c:a", "pcm_s24le", str(into)], check=True, timeout=900)
            got = into
        one.unlink(missing_ok=True)
    if raw is not None:
        raw.unlink(missing_ok=True)
    return got


def vocals_of(path: Path) -> Path:
    """Vocals with the instrumental removed, extracted once and reused.

    Aligning against the original mix makes the model hear the instrumental where the singing has
    stopped and emit arbitrary characters. "This part is blank" then never holds, and the last word
    of a line stretches right up to the next line.

    **demucs was dropped in favour of BS-Roformer.** demucs `htdemucs_ft` scores 9~10 vocal SDR
    against **12.98** here. A human listened to the demucs version and said the instrumental
    removal was poor; the two were played side by side and this one was chosen. Alignment scores
    were the same either way (3 collapsed lines both times) — the difference is the sound.

    The price is time: demucs takes 29 s, this takes a bit over 3 minutes. It runs once per song
    and is cached, so it is worth paying.

    @param {Path} path - The original audio file.
    @returns {Path} Path to the cached `.vocals.wav`.
    @throws {RuntimeError} When no vocal stem comes back from the separator.
    """
    made = path.with_suffix(".vocals.wav")
    if made.exists():
        return made
    got = cut_apart(path, VOCALS_MODEL, "(Vocals)", made)
    if got is None:
        raise RuntimeError(f"보컬 갈래를 못 찾는다: {path.name}")
    return got


def voices_of(path: Path) -> tuple[Path, Path]:
    """Split the vocals into **lead** and **backing** (harmonies, ad libs), once and cached.

    Why split at all: forced alignment **keeps order** — it can only attach lyric characters to
    sound in the order they are written. Backing vocals, though, are sung **at the same time** as
    the lead. The lyric file lists them one after another, so the alignment tries to place them in
    sequence and one line ends up eating another line's sound — Small girl's 「(If, if I got a…)」
    was squashed into 0.88 s one time and stretched to 10.23 s the next. **As long as two voices
    share one stem this cannot be fixed.**

    The vocal-extraction model is not enough: it separates voices from instruments, not voices from
    each other. A UVR-family **karaoke** model is what splits those two.

    **Runs on XPU/CUDA.** audio-separator only looks for cuda, mps and directml, misses the Arc and
    falls back to CPU, where a four-minute song took **20 minutes 51 seconds** and was unusable.
    Swapping `torch_device` after construction brings it down to 4 minutes — 5.4x.

    **The stems must not be picked by name.** For this model `(Vocals)` is the backing and
    `(Instrumental)` is the lead: karaoke models name the instrumental as "everything minus the
    lead", and since we feed it vocals that already have the instrumental removed, the meaning
    inverts. Trusting the names attached lead and backing the wrong way round, and the user caught
    it — "this is supposed to be the backing but the main voice is still in it". They are picked by
    loudness instead: the lead is louder than the backing, measured 0.1248 against 0.0279, a factor
    of 4.5. That property does not change with the release.

    The stems are copied out **at full quality**. Downmixed to 16 kHz mono they sounded "badly
    broken up" to the human listening in the studio. `read_audio` downsamples only when feeding the
    aligner — there is no reason to store a downsampled copy.

    @param {Path} path - The original audio file.
    @returns {tuple[Path, Path]} Paths to the cached lead and backing wav files.
    @throws {RuntimeError} When the separator does not return two stems.
    """
    lead = path.with_suffix(".lead.wav")
    back = path.with_suffix(".back.wav")
    if lead.exists() and back.exists():
        return lead, back

    import torch
    from audio_separator.separator import Separator

    voice = vocals_of(path)
    into = path.parent / "split"
    into.mkdir(exist_ok=True)
    apart = Separator(output_dir=str(into), output_format="WAV", log_level=40)
    apart.torch_device = torch.device(device())
    apart.load_model(model_filename=KARAOKE_MODEL)
    made = apart.separate(str(voice))

    loud = []
    for name in made:
        got = into / name
        if got.exists():
            loud.append((float(read_audio(got).pow(2).mean().sqrt()), got))
    if len(loud) < 2:
        raise RuntimeError(f"갈래가 둘이 아니다: {made}")
    loud.sort(reverse=True)
    for want, (_, got) in zip((lead, back), loud):
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(got),
                        "-c:a", "pcm_s24le", str(want)], check=True, timeout=600)
    for _, got in loud:
        got.unlink(missing_ok=True)
    return lead, back


def weigh(log_probs, tokens: list[int], since: int, until: int):
    """Align inside frames [since, until) only, and report the **mean per-token score** together
    with the first token's frame.

    A mean rather than a sum because windows differ in length; scored by sum, the longer window
    always wins.

    @param {torch.Tensor} log_probs - `(1, frames, vocabulary)` log probabilities.
    @param {list[int]} tokens - Token ids to align inside the window.
    @param {int} since - First frame of the window.
    @param {int} until - One past the last frame of the window.
    @returns {tuple[float, int] | None} Mean per-token score and the absolute frame of the first
      token, or None when the window cannot hold the tokens or alignment fails.
    """
    import torch
    import torchaudio.functional as F

    piece = log_probs[:, since:until]
    if piece.shape[1] < len(tokens) or not tokens:
        return None
    try:
        paths, scores = F.forced_align(piece, torch.tensor([tokens]), blank=0)
    except Exception:
        return None
    merged = F.merge_tokens(paths[0], scores[0], blank=0)
    if len(merged) != len(tokens):
        return None
    return float(scores[0].sum()) / len(tokens), since + merged[0].start


def rethink(log_probs, tokens, heads, spans, lines, merged, per_frame):
    """Re-examine lines that fall far from the outside line time, **using the audio as evidence**.

    Why this is needed: aligning the whole song at once grabs the wrong spot in repeated phrases.
    When 「그럼에도 불구하고」 appears three times in the lyrics and the audio holds further repeats
    that were never written down, the alignment picks an earlier one — lines 25 and 27 were both
    right while line 26 alone was dragged 2.66 s early.

    But **the outside time must not be trusted unconditionally.** Measured, half of the badly-off
    lines were ours to keep — 파란달팽이 47·48 and Small girl 60·61·62 scored 2.7~6.0 better per
    token where we had put them. Either the YouTube audio and the Naver master are different
    arrangements, or the outside time is wrong. Pulling unconditionally would have wrecked those
    songs by 14 s each.

    So **the model is asked.** The line is aligned at both positions inside equal-length windows,
    and it is moved only when the outside position scores more than `EVIDENCE` better. This differs
    from the earlier failure of "re-align only the off line between its neighbours" — that fed the
    same window back and got the same answer, whereas here the **outside time** is new information
    that builds a **different window**. The two windows are made the same length; different lengths
    would let the score be decided by length.

    A song-wide offset is not alignment jitter but a different release of the audio, so the median
    offset is subtracted before anything else is judged. Each line's placed span is recorded once,
    because both tests below look at it.

    Test 1 — structural breakage. A score duel cannot tell repeats apart: when the same phrase
    occurs twice **both windows contain that phrase**, so the choice becomes which is clearer
    rather than which is right. Instead of asking the audio, this asks whether **the result
    contradicts itself**. Small girl 18·19 does — line 18 holds 12 characters at 0.88 s and line 19
    holds 12 characters at 10.23 s, and their spans overlap. Two lines are stacked on the same
    sound, and a healthy alignment does not produce that. Two conditions mark a line broken: its
    span overlaps the previous line's, or four or more characters sit at exactly the minimum
    spacing — the mark left where the alignment wanted to squeeze tighter and the rules blocked it.
    Here the outside time is trusted **without asking for a score**, but to keep it from wandering
    the pin is driven only **inside the span the broken pair already occupies** — redividing sound
    we already claimed, not carrying it somewhere else. That fence is what stopped songs on a
    different release (파란달팽이, the back half of Small girl) from being wrecked by 14 s.

    Test 2 — consecutive takes of the same text **stretched out with mismatched spacing**. Small
    girl's three 「(If, if I got a…)」 (18·19·20) are exactly that: they neither overlap nor squash,
    so the tests above miss them, yet the lines run 8.17 and 9.65 s against the 2~3 s of the other
    takes. Line 17 ends at 49 s and line 21 starts at 71.5 s, so the three split the 22.5 s between
    them evenly — swallowing the instrumental break in the middle. Stretch and spacing mismatch have
    to be read **together**: spacing alone would shake healthy lines whenever the outside time points
    at a different release, while stretch is a contradiction inside our own result and holds without
    trusting the outside at all; the spacing then says where to move to. The local widths here are
    deliberately not named `spans` — that is this function's parameter for per-line token counts, and
    shadowing it would count the wrong thing.

    Pins must keep their order and **leave frames for every segment**. A token needs at least one
    frame for CTC to build a path, so pins packed too tightly starve a segment and make `pinned`
    fail wholesale, leaving the second pass with nothing to do — better to filter here. Pins are
    taken in order and only those with no room are dropped.

    @param {torch.Tensor} log_probs - `(1, frames, vocabulary)` log probabilities for the song.
    @param {list[int]} tokens - Every token of the song, in order.
    @param {list[int | None]} heads - Index of each line's first token, or None when it has none.
    @param {list[int]} spans - Token count per line.
    @param {list[dict]} lines - Lyric lines carrying the outside start time in "at".
    @param {list} merged - Per-token spans from the first alignment pass.
    @param {float} per_frame - Milliseconds per frame.
    @returns {list[tuple[int, int]]} Pins to drive, as (token index, frame).
    """
    if not heads:
        return []
    gaps = [merged[head].start * per_frame - lines[index]["at"]
            for index, head in enumerate(heads)
            if head is not None and lines[index].get("at") is not None]
    if not gaps:
        return []
    bias = sorted(gaps)[len(gaps) // 2]

    reach = {}
    for index, head in enumerate(heads):
        if head is None or not spans[index]:
            continue
        last = head + spans[index] - 1
        reach[index] = (merged[head].start, merged[last].start, spans[index])

    floor = CRAMP_MS / per_frame
    broken = set()
    for index in reach:
        start, stop, count = reach[index]
        before = reach.get(index - 1)
        if before and start < before[1]:
            broken.add(index)
            broken.add(index - 1)
        if count >= 4 and (stop - start) <= (count - 1) * floor + 1:
            broken.add(index)

    said_text = [" ".join(one.get("text", "").split()) for one in lines]
    twin = {}
    for index, text in enumerate(said_text):
        if index in reach and text:
            twin.setdefault(text, []).append(index)
    for index in list(reach):
        text = said_text[index]
        mates = [one for one in twin.get(text, []) if one != index]
        if not mates or lines[index].get("at") is None:
            continue
        widths = sorted((reach[one][1] - reach[one][0]) for one in mates)
        mid = widths[len(widths) // 2]
        mine = reach[index][1] - reach[index][0]
        if mid > 0 and mine > mid * STRETCH:
            broken.add(index)

    pins = []
    for index, head in enumerate(heads):
        if head is None or lines[index].get("at") is None:
            continue
        ours = merged[head].start * per_frame
        said = lines[index]["at"] + bias
        if index in broken:
            near = [one for one in (index - 1, index, index + 1) if one in reach]
            low = min(reach[one][0] for one in near) * per_frame
            high = max(reach[one][1] for one in near) * per_frame
            if low <= said <= high:
                pins.append((head, int(said / per_frame)))
                continue
        if abs(ours - said) <= SUSPECT_MS:
            continue
        mine = tokens[head: head + spans[index]]
        if not mine:
            continue
        width = max(len(mine) * 120, 2500) + 2 * LOOK_MS
        weighed = []
        for middle_ms in (ours, said):
            since = max(0, int((middle_ms - LOOK_MS) / per_frame))
            until = min(log_probs.shape[1], int((middle_ms - LOOK_MS + width) / per_frame))
            weighed.append(weigh(log_probs, mine, since, until))
        if weighed[0] is None or weighed[1] is None:
            continue
        if weighed[1][0] - weighed[0][0] > EVIDENCE:
            pins.append((head, weighed[1][1]))

    total = log_probs.shape[1]
    kept: list[tuple[int, int]] = []
    for head, frame in pins:
        before_head, before_frame = kept[-1] if kept else (0, 0)
        if frame - before_frame < head - before_head:
            continue
        if total - frame < len(tokens) - head:
            continue
        kept.append((head, frame))
    return kept


def pinned(log_probs, tokens: list[int], pins):
    """Split at the pinned frames, align each segment on its own, and stitch the result together.

    The earlier "put a window on every line and align separately" failed — the slightest error in a
    window's end piled the remaining characters into its last few frames. What differs here is that
    **the segments are large** (a song gets one or two pins) and the boundaries were chosen from
    evidence in the audio. This does not cut per line.

    If even one segment fails it **backs out entirely.** The original answer beats a half-aligned
    one.

    @param {torch.Tensor} log_probs - `(1, frames, vocabulary)` log probabilities for the song.
    @param {list[int]} tokens - Every token of the song, in order.
    @param {list[tuple[int, int]]} pins - Pins from `rethink`, as (token index, frame).
    @returns {list | None} Per-token spans in absolute frames, or None when any segment failed.
    """
    import torch
    import torchaudio.functional as F

    cuts = [(0, 0)] + list(pins) + [(len(tokens), log_probs.shape[1])]
    out = []
    for (head, since), (next_head, until) in zip(cuts, cuts[1:]):
        piece_tokens = tokens[head:next_head]
        if not piece_tokens:
            continue
        piece = log_probs[:, since:until]
        if piece.shape[1] < len(piece_tokens):
            return None
        try:
            paths, scores = F.forced_align(piece, torch.tensor([piece_tokens]), blank=0)
        except Exception:
            return None
        got = F.merge_tokens(paths[0], scores[0], blank=0)
        if len(got) != len(piece_tokens):
            return None
        for span in got:
            span.start += since
            span.end += since
        out.extend(got)
    return out if len(out) == len(tokens) else None


def align_song(path: Path, lines: list[dict], tokenize, separate: bool = True) -> list[list[dict]]:
    """Align one song **in a single pass** and return the per-line word list.

    No window is placed per line. Line times mark only the **start**, so any window end is wrong,
    and when it is wrong the remaining characters pile into the last few frames 0.02 s apart.
    Laying the whole song out as one token sequence removes that wall entirely — CTC alignment
    searches for the path that is **most likely as a whole** for the given token sequence, so one
    ambiguous spot is not pushed forward into the rest.

    Line times are no longer used for aligning at all, only for handing the result back to lines.

    MMS_FA's blank is token 0. The earlier version, on a Korean ASR model, got that id wrong and
    aligned with the character 「볍」 treated as blank — it guessed instead of asking the tokenizer.

    Token counts are recorded per character (`plan` is line → word → [(grain, token count)]); the
    **first token** of a chunk is where that character starts. Each line also records **which token
    index it starts at and how many it holds**, which is what lets one line be re-examined below.

    A second pass then walks back over lines that grabbed the wrong spot in a repeated phrase,
    using evidence from the audio. It moves only on clear evidence — most of the time nothing moves
    and the first answer stands — and if any segment fails it backs out wholesale, because the
    original answer beats a half-corrected one.

    Starts are pulled earlier by a fixed amount. CTC uses only one frame per character (it is
    peaky) and that frame is **the moment the character is clearest**, which for a Hangul syllable
    is the middle of the vowel while singing starts on the consonant. So the alignment runs late as
    a whole — measured across three songs at +0.18·+0.22·+0.25 s, late regardless of the song. A
    bias caused by differing audio would vary song to song, and it did not.

    Walking back per syllable by loudness was tried: the lateness shrank (+0.22 → +0.02) but
    **consistency was destroyed** — the bias-removed error went from 15 ms to 135 ms, because every
    character moved on its own. For karaoke, being consistently late beats being erratic; the first
    can be subtracted, the second cannot. So the measured amount is pulled off everything — not an
    arbitrary number but the value three songs produced.

    The pull is capped **at the gap to the previous character**. Pulling everything equally broke
    the fast passages: where characters sit closer than 200 ms (rap, quick choruses) they collided,
    and preventing overlap crammed them to 20 ms apart — 「잠깐이면」 came out at 42.93·42.97·43.01,
    which nobody sings at that speed. Only half the gap to the previous character is taken, so tight
    spots move a little and roomy ones take the full 200 ms; what is being corrected is the "lands
    mid-vowel" property anyway, and that error shrinks along with the syllable. A final ordering
    pass makes sure nothing was pulled past its predecessor.

    Ends run to the next peak. A re-aligned line no longer agrees with `merged`'s ends, so using
    them directly produces an end that precedes its own start. Ends are then **stretched** until the
    next character starts — the earlier version used `min` here and cut back the very stretch it
    meant to make, leaving all 246 of them at 0.02 s. They are not stretched without limit though:
    gluing on the instrumental break between lines makes a line's last character swell by 8 s, and
    the singing already stopped there. The last character's tail is kept only as far as the audio
    supports it.

    Per-character confidence is measured **by comparison, not in absolute terms** — how much worse
    this character is than whatever the model picked at that frame. Zero means the model heard the
    same character; strongly negative means it hears something else while we insist the character
    belongs here. The score `merge_tokens` hands back is the **mean** log probability over the span
    and cannot serve as confidence: a long-held character has its later frames dragging the mean
    down, so well-aligned characters score low — that is why 168 of 252 came up doubtful. Absolute
    values fail the same way: a model trained on read speech scores singing low everywhere (median
    −4.5, about 1%), and 168 of 252 were flagged. The maximum is used rather than the mean because
    CTC is peaky — with a one-frame span both are equal, but on long-held notes the maximum is right.

    Doubtful spots are picked **by comparison within the song**. An absolute threshold is useless:
    singing is outside this model's training distribution and scores low everywhere, and cutting at
    −1.5 catches 159 of 252, which defeats the point. Confidence in fact splits in two — where the
    model heard the same character it is **exactly 0**, and elsewhere it drops below −3 — so rather
    than trimming a tail with quartiles, the question is simply **did the model hear a different
    character**; 3 nat (a factor of twenty in probability) counts as a different sound. The earlier
    reading of "it is singing, so everything is low" was wrong.

    Large gaps inside a line cannot be fixed here. The 싶 (40.87) and 어 (42.49) of
    「숨 좀 쉬고 싶어서」 sit 1.62 s apart. Re-aligning that line alone between its neighbours **gave
    exactly the same answer** — aligning the same tokens in a sub-window of the same log_probs
    leaves the originally chosen path inside that window, and narrowing the window cannot make the
    alignment give up a path it already chose. The model genuinely claims to hear 어 there, so
    fixing it takes a different model or a human; the passage is flagged as doubtful and goes to a
    person.

    Characters are then refolded into line → word → character. A line's characters are flattened
    and filled in one go: filling within a word alone leaves a word made entirely of
    out-of-vocabulary characters (a word of nothing but syllables like 「괜」) with nothing to lean
    on, so it would stay empty. One character can map to several Latin letters — 「괜」 is `gwaen`,
    five — and that character runs from **the start of the first letter** to **the end of the
    last**; the first Latin letter is usually the leading consonant, so it lines up with where the
    syllable starts. The **weakest letter** in the chunk becomes the character's confidence: if one
    of five sits somewhere else, the character cannot be trusted. Out-of-vocabulary characters were
    never aligned at all, so they are always doubtful, and a word's confidence follows its weakest
    character for the same reason. A line with no aligned character at all has no time and is left
    empty for a human — inventing a number would read as "the model placed this".

    @param {Path} path - Audio to align against.
    @param {list[dict]} lines - Lyric lines, each with text and an outside start time.
    @param {callable} tokenize - Splits a line's text into alignable words.
    @param {bool} [separate=True] - Extract vocals first; False when `path` is already a stem.
    @returns {list[list[dict]]} Per-line word dicts carrying character-level timings.
    """
    import torch
    import torchaudio.functional as F

    audio = read_audio(vocals_of(path) if separate else path)
    load()
    blank = 0

    tokens: list[int] = []
    plan: list[list[list[tuple[str, int]]]] = []
    heads: list[int | None] = []
    spans: list[int] = []
    for line in lines:
        rows: list[list[tuple[str, int]]] = []
        head, count = None, 0
        for word in tokenize(line.get("text", "")):
            row: list[tuple[str, int]] = []
            for grain in grains_of(speakable(word)):
                got = letters(grain)
                if got and head is None:
                    head = len(tokens)
                count += len(got)
                tokens.extend(got)
                row.append((grain, len(got)))
            rows.append(row)
        plan.append(rows)
        heads.append(head)
        spans.append(count)
    if not tokens:
        return [[] for _ in lines]

    log_probs = whole_logits(audio)
    if len(tokens) > log_probs.shape[1]:
        return [[] for _ in lines]

    paths, scores = F.forced_align(log_probs, torch.tensor([tokens]), blank=blank)
    merged = F.merge_tokens(paths[0], scores[0], blank=blank)
    if len(merged) != len(tokens):
        return [[] for _ in lines]

    per_frame = audio.shape[-1] / log_probs.shape[1] / SAMPLE_RATE * 1000

    pins = rethink(log_probs, tokens, heads, spans, lines, merged, per_frame)
    if pins:
        again = pinned(log_probs, tokens, pins)
        if again is not None:
            merged = again

    lead = int(ONSET_LEAD_MS / per_frame)
    peaks = [span.start for span in merged]

    starts = []
    for index, peak in enumerate(peaks):
        room = peak if index == 0 else (peak - peaks[index - 1]) // 2
        starts.append(max(0, peak - min(lead, max(0, room))))
    for index in range(1, len(starts)):
        starts[index] = max(starts[index], starts[index - 1] + 1)

    marks = [[int(one * per_frame), int(max(peak + 1, span.end) * per_frame)]
             for one, peak, span in zip(starts, peaks, merged)]
    best = log_probs[0].max(dim=-1).values
    sure = []
    for peak, span in zip(peaks, merged):
        stop = min(log_probs.shape[1], max(peak + 1, peak + (span.end - span.start)))
        gap = (log_probs[0, peak:stop, int(span.token)] - best[peak:stop]).max()
        sure.append(float(gap))

    shaky = [one < DOUBT for one in sure]
    for one, two in zip(marks, marks[1:]):
        one[1] = max(one[0] + 20, min(two[0], one[0] + HOLD_MS))
    best = log_probs[0].max(dim=-1).values
    edge = merged[-1].end
    while edge > merged[-1].start + 1 and float(best[edge - 1] - log_probs[0, edge - 1, tokens[-1]]) > SUPPORT:
        edge -= 1
    marks[-1][1] = max(marks[-1][0] + 20, min(int(edge * per_frame), marks[-1][0] + HOLD_MS))

    out: list[list[dict]] = []
    at = 0
    for rows in plan:
        flat: list[dict] = []
        shape: list[int] = []
        for row in rows:
            shape.append(len(row))
            for letter, count in row:
                if count:
                    one = marks[at][0]
                    two = marks[at + count - 1][1]
                    worst = min(range(at, at + count), key=lambda i: sure[i])
                    flat.append({"text": letter, "at": one, "end": max(two, one + 20),
                                 "sure": round(sure[worst], 3),
                                 **({"shaky": True} if any(shaky[at: at + count]) else {})})
                    at += count
                else:
                    flat.append({"text": letter, "at": None, "end": None,
                                 "sure": -9.0, "shaky": True})
        fill_gaps(flat)
        loosen_chars(flat)

        words_out: list[dict] = []
        cut = 0
        for size in shape:
            chars = flat[cut: cut + size]
            cut += size
            if not chars or chars[0]["at"] is None:
                continue
            words_out.append({
                "text": "".join(one["text"] for one in chars),
                "at": chars[0]["at"],
                "end": max(chars[-1]["end"], chars[0]["at"] + LEAST_MS),
                "sure": round(min(one["sure"] for one in chars), 3),
                **({"shaky": True} if any(one.get("shaky") for one in chars) else {}),
                "chars": chars,
            })
        out.append(words_out)
    flag_stuck(lines, out)
    return out


def align_voices(path: Path, lines: list[dict], tokenize, title: str = ""):
    """Align a song against every separated stem and keep the best placement per line.

    Forced alignment is monotonic, so a single stem cannot hold two voices singing at
    once. The lead stem carries the base pass; the backing, vocals and original stems each
    get their own pass, and a line adopts another stem's timing only when that stem scores
    clearly better, lands near either the base placement or the outside line time, and does
    not stretch past twice the base span. Those three gates are what keep a repeated phrase
    from flying tens of seconds away, which it did before they existed.

    Only lines adopted from the backing stem record their source. Speaker embeddings taken
    from whichever stem happened to win group lines by stem timbre rather than by singer —
    a solo song split 16/8/3 that way — while the backing stem genuinely holds a different
    voice and is safe to trust. Taking a backing line's embedding off the lead stem would be
    sampling bleed, which then reads as the main voice.

    1. **Every line is aligned on the lead stem.** Keeping all the lines matters: aligning each
       stem with only its own lines left in took collapsed lines from 2 to 20 — dropping a line
       leaves a hole in the sequence and the remaining lines stretch to fill it.

       Which stem to build the base on was once answered wrongly. The note used to say "the
       karaoke model shaves the lead, so demucs vocals are better", but the file being called
       the lead back then was in fact the **backing** — the names were trusted and attached the
       wrong way round. Corrected and re-measured over eight songs, the lead stem wins: collapsed
       lines 18 → 14, three songs better and none worse.

    2. **Each of four stems is aligned and the best placement is taken per line.** Solving this
       by picking a better stem is a dead end: eighteen models were compared and **every one**
       discarded Small girl's lines 20 and 62 as "not the main voice" (47% on healthy lines
       against 3~9% on those). Backing-vocal-only models (BVE) throw the lead away and fail the
       other way, and running karaoke straight on the original gives 0%. The models learned
       `vocals` as **lead singing**, and a heavily processed ad lib lies outside that.

       So instead of choosing one stem well, **several are laid over each other and the choice is
       made per line.** Sound that no stem can isolate is always present in the original — mixed
       with the instrumental and shakier for it, but better than nothing.

       **Which stem a line was aligned on has nothing to do with its lane.** Lines aligned on the
       backing stem were given lane 1 for a while, but that says "this stem fitted better", not
       "someone else sings it". Widening to four stems exposed the confusion — a solo song split
       14 against 9, and one song produced 29 clusters with 19 singletons. Lanes are decided only
       by `who_sings` below.

    3. Rescues are fenced in three ways. A rescued line must land near **either** the lead's
       placement **or** the outside line time: a line the lead never had sound for cannot be
       fenced by the former, so the latter has to exist, and without the fence a repeated phrase
       goes anywhere in the song (47~147 s jumps). It must not run more than `STRETCH` times the
       base span — scoring alone let line 19 come in at 16.01 s, because a stretched line can
       score well per character when it passes over silence and any character can be the model's
       top pick at an empty frame. And its weakest character must beat the current weakest by
       `VOICE_EDGE`; one character out of place makes the line untrustworthy.

    4. **Lines belonging to another singer are re-aligned among themselves only.** Forced
       alignment keeps order, so lining every line up on one stem makes it **impossible for two
       lines to occupy the same moment** — sweeping the timeline showed 97~100% of the sounding
       time held exactly one line. Duets were not being missed; they were **inexpressible**.
       Different people have no reason to keep order with each other, so putting one singer's
       lines into a sequence of their own keeps that singer internally ordered while letting them
       overlap another singer freely.

       "Align each stem with only its own lines" was a large earlier misstep (collapsed lines
       2 → 20). Two things differ here: the base is left alone and only **the other singer's**
       lines are touched, and a placement far from the base or the outside time is discarded. If
       it is not trustworthy, nothing changes.

    Collapse flags are **recomputed after the merge**. `flag_stuck` runs inside `align_song`, so
    swapping lines in here would leave flags pointing at the old result — the server's saved output
    and the probe's measurements disagreed and cost a long hunt, because the screen was showing one
    thing while something else was being measured. Recomputing also surfaces the traces a rescue
    leaves on its neighbours: sending line 18 to the backing stem can make line 19 stretch to fill
    the vacated space, and a human should see that too.

    @param {Path} path - The original audio file.
    @param {list[dict]} lines - Lyric lines, each with text and an outside start time.
    @param {callable} tokenize - Splits a line's text into alignable words.
    @param {str} [title=""] - Song title, used as a weak hint that several singers exist.
    @returns {tuple[list[list[dict]], dict[int, int]]} Per-line words, and per-line lane.
    """
    lead, back = voices_of(path)

    lanes: dict[int, int] = {index: 0 for index in range(len(lines))}
    tries = [("리드", lead), ("서브", back), ("보컬", vocals_of(path)), ("원본", path)]
    out = align_song(lead, lines, tokenize, separate=False)
    from_stem: dict[int, Path] = {index: lead for index in range(len(lines))}

    marks = [(index, one[0]["at"]) for index, one in enumerate(out)
             if one and lines[index].get("at") is not None]
    bias = (sorted(at - lines[index]["at"] for index, at in marks)[len(marks) // 2]
            if marks else 0)

    for name, stem in tries[1:]:
        other = align_song(stem, lines, tokenize, separate=False)
        for index, got in enumerate(other):
            if not got or got[0].get("stuck"):
                continue
            now = [one for word in got for one in (word.get("chars") or [])]
            was = [one for word in out[index] for one in (word.get("chars") or [])]
            if not now:
                continue

            near = []
            if was:
                near.append(abs(now[0]["at"] - was[0]["at"]))
            if lines[index].get("at") is not None:
                near.append(abs(now[0]["at"] - (lines[index]["at"] + bias)))
            if not near or min(near) > RESCUE_REACH_MS:
                continue

            span = now[-1]["at"] - now[0]["at"]
            held = (was[-1]["at"] - was[0]["at"]) if len(was) > 1 else span
            if len(now) > 1 and held > 0 and span > held * STRETCH:
                continue

            after = min(one.get("sure", -9.0) for one in now)
            before = min((one.get("sure", -9.0) for one in was), default=-9.0)
            if after - before <= VOICE_EDGE:
                continue
            out[index] = got
            if stem == back:
                from_stem[index] = stem

    who = who_sings(from_stem, lines, out, title)
    for index, one in enumerate(who):
        if one:
            lanes[index] = one

    for lane in sorted({one for one in lanes.values() if one}):
        mine = [index for index, one in lanes.items() if one == lane]
        if len(mine) < 2:
            continue
        only = [lines[index] if index in set(mine) else {**line, "text": ""}
                for index, line in enumerate(lines)]
        apart = align_song(back, only, tokenize, separate=False)
        for index in mine:
            got = apart[index]
            if not got or got[0].get("stuck"):
                continue
            now = [one for word in got for one in (word.get("chars") or [])]
            was = [one for word in out[index] for one in (word.get("chars") or [])]
            if not now:
                continue
            near = [abs(now[0]["at"] - was[0]["at"])] if was else []
            if lines[index].get("at") is not None:
                near.append(abs(now[0]["at"] - (lines[index]["at"] + bias)))
            if not near or min(near) > RESCUE_REACH_MS:
                continue
            span = now[-1]["at"] - now[0]["at"]
            held = (was[-1]["at"] - was[0]["at"]) if len(was) > 1 else span
            if len(now) > 1 and held > 0 and span > held * STRETCH:
                continue
            out[index] = got

    settle_lanes(out, lanes)

    for words in out:
        for word in words:
            word.pop("stuck", None)
    flag_stuck(lines, out)
    return out, lanes


def settle_lanes(out: list[list[dict]], lanes: dict[int, int]) -> None:
    """Trim ends so that lines of the same voice never overlap. Edits `out` in place.

    **One person cannot sing two lines at once.** The alignment stretches a line's end to the next
    character, and choosing across stems leaves two lines of the same lane overlapping — Small
    girl's line 18 (48.56~54.20) and line 19 (51.74~58.74) overlapped by 2.46 s, and the screen read
    that as "both are being sung at once" and lit the same text twice. That is the spot the user
    described as "it claims they sing the wrong place together".

    Lines in **different** lanes are left alone. That overlap is a real duet, and it is exactly what
    this tool exists to show.

    A character placed after the next line has already started cannot be trusted, but it is not
    deleted — a character vanishing from the screen makes the lyric look empty.

    @param {list[list[dict]]} out - Per-line word dicts, modified in place.
    @param {dict[int, int]} lanes - Lane number per line index.
    @returns {None}
    """
    per: dict[int, list[int]] = {}
    for index, words in enumerate(out):
        if words:
            per.setdefault(lanes.get(index, 0), []).append(index)

    for mine in per.values():
        ordered = sorted(mine, key=lambda one: out[one][0]["at"])
        for here, after in zip(ordered, ordered[1:]):
            starts = out[after][0]["at"]
            chars = [one for word in out[here] for one in (word.get("chars") or [])]
            for grain in chars:
                if grain["at"] >= starts:
                    grain["at"] = min(grain["at"], max(0, starts - LEAST_MS))
                grain["end"] = min(grain.get("end") or grain["at"], starts)
                grain["end"] = max(grain["end"], grain["at"] + 20)
            for word in out[here]:
                got = word.get("chars") or []
                if got:
                    word["at"] = got[0]["at"]
                    word["end"] = max(one["end"] for one in got)


#: Shapes in a title that say several people sing. Their presence lowers the threshold — their
#: absence does not mean the song is a solo.
MANY_VOICES = re.compile(r"\b(feat\.?|featuring|with)\b", re.I)
#: Even one person's embedding wobbles in singing, so lines shorter than this (ms) are not used
#: at all.
VOICE_LEAST_MS = 1000
#: How many **consecutive lines** a cluster needs before it counts as a different singer.
#:
#: Why measure it as a run: when the singer changes, that singer takes a whole passage, so the
#: line numbers **run consecutively**. One person's changes of delivery scatter all over the song.
#:
#: The value is a chosen trade-off. Measured over nine songs:
#:
#:   threshold 6 — none of the five solo songs split (good), but Bigbang's 「붉은 노을」 split only
#:                 5 lines; members trade two or three lines at a time and no run of 6 appears.
#:   threshold 3 — 붉은 노을 splits properly at 19 lines, but two solo songs get confused.
#:
#: **3 was chosen because the two mistakes cost different amounts.** This number never touches
#: timing — it only decides which column to draw in and what colour to paint. A false split is
#: merely confusing to look at, while failing to split means the feature does not exist at all.
#:
#: Four better yardsticks were tried and failed: a distance threshold (clusters scattered to
#: 15~47), the silhouette score (**a solo song scored higher than a featuring one** — clusterability
#: measures delivery, not people), `Feat.` in the title (misses groups entirely), and the
#: consistency of repeated phrases (solo 100% against 79~83% for multiple, i.e. backwards).
VOICE_RUN = 3
#: Used when the title says several people sing; the same value, because there is no room to go
#: lower.
VOICE_RUN_TOLD = 3
#: Model that strips the instrumental. Vocal SDR 12.98, above demucs htdemucs_ft (9~10).
VOCALS_MODEL = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"
#: Model that splits the vocals into lead and backing.
KARAOKE_MODEL = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"


def who_sings(from_stem: dict[int, Path], lines: list[dict], out: list[list[dict]],
              title: str) -> list[int | None]:
    """Decide **who sings** each line: 0 = the singer with the most lines, 1·2 = the rest, None
    when it cannot be decided.

    What the karaoke model separates is "lead against harmony", not **who**. A featured singer sings
    lead alone, so they land in the lead stem untouched and no split happens even though the voice
    changes plainly — that is exactly what the user pointed out. This is a different measurement
    from the backing-stem rescue in `align_voices`: that one asks "is this harmony", this one asks
    "who is it".

    To separate people, a **speaker embedding** is taken per voice and similar ones are clustered.
    `speechbrain`'s ECAPA-TDNN is used, and the embeddings are taken **per line** — the usual
    approach of sweeping a window over the audio to find speaker boundaries is unnecessary because
    we already know where every line starts and ends. Each stem is read exactly once; reading per
    line would decode the same file dozens of times.

    **Whether there are several singers is decided by "does it clump".** Three wrong turns led here:

    1. Choosing the count by a distance threshold scattered the clusters to 15~47. ECAPA was trained
       on speech, so in singing even one person's embedding wobbles heavily with pitch and delivery.
    2. Choosing by silhouette score made **a solo song score higher than a featuring one**
       (0.350 against 0.322). Clusterability measures whether the **delivery** splits, not whether
       the people do.
    3. Leaning on `Feat.` in the title **missed groups entirely** — a team like Bigbang has four or
       five members trading lines with no mark in the title at all.

    What works is **position**. When the singer changes, that singer takes a whole verse, so the line
    numbers come out as a **consecutive run**. One person's changes of delivery scatter across the
    song. Measured over eight songs, the longest run in songs with another singer was 7·12·11, while
    solo songs gave 4·1·5·1·2.

    On Small girl only `[18, 19, 60, 61]` clustered apart — exactly the ground truth the user gave,
    with no false positives (lines 20 and 62 fell under a second and dropped out of the measurement).

    The most-sung cluster is numbered 0; if the numbering flipped from song to song the screen would
    be unreadable.

    **Singleton lines are erased.** When the lines on either side are the same person and only one in
    between differs, that is not a change of singer but a wobble in the embedding — ECAPA was trained
    on speech and the same person moves a great deal with pitch and delivery. One song produced
    nineteen singletons and the user read that as "it vaguely does not work". Real speaker changes
    arrive in clumps; that property already decides **whether to split at all** through `VOICE_RUN`,
    and the **per-line values** after deciding to split have to inherit it for the two to agree.

    A majority vote of "the same text is the same person" was tried and reverted. The majority of a
    repeat sits in lane 0, so it **dragged correctly split minorities back** (ground truth 3/6 → 2/6)
    and even shredded solo songs into 15/9/3. Identical text is a genuine clue, but following the
    majority on it means following a wrong majority.

    @param {dict[int, Path]} from_stem - Which stem each line was aligned on.
    @param {list[dict]} lines - Lyric lines, unused for timing here.
    @param {list[list[dict]]} out - Per-line word dicts carrying character timings.
    @param {str} title - Song title, used as a weak hint that several singers exist.
    @returns {list[int | None]} Singer index per line, or None where undecided.
    """
    import torch
    from sklearn.cluster import AgglomerativeClustering

    if "voice" not in _bundle:
        from speechbrain.inference.speaker import EncoderClassifier
        _bundle["voice"] = EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            savedir=str(Path(__file__).parent / "models/ecapa"),
            run_opts={"device": device()})
    model = _bundle["voice"]

    heard: dict[Path, object] = {}
    for one in set(from_stem.values()):
        heard[one] = read_audio(one)[0]

    least = VOICE_LEAST_MS / 1000 * SAMPLE_RATE
    where, marks = [], []
    with torch.inference_mode():
        for index, words in enumerate(out):
            chars = [one for word in words for one in (word.get("chars") or [])]
            if not chars:
                continue
            audio = heard[from_stem.get(index, next(iter(heard)))]
            since = int(chars[0]["at"] / 1000 * SAMPLE_RATE)
            until = int((chars[-1]["end"] or chars[-1]["at"]) / 1000 * SAMPLE_RATE)
            if until - since < least or since < 0 or until > audio.shape[-1]:
                continue
            where.append(index)
            marks.append(model.encode_batch(
                audio[since:until].unsqueeze(0).to(device())).squeeze().cpu())
    if len(marks) < 8:
        return [None] * len(out)

    stack = torch.stack(marks)
    stack = stack / stack.norm(dim=1, keepdim=True).clamp(min=1e-9)
    labels = AgglomerativeClustering(
        n_clusters=3, metric="cosine", linkage="average").fit(stack.numpy()).labels_

    groups: dict[int, list[int]] = {}
    for index, label in zip(where, labels):
        groups.setdefault(int(label), []).append(index)
    order = sorted(groups.values(), key=len, reverse=True)

    need = VOICE_RUN_TOLD if MANY_VOICES.search(title or "") else VOICE_RUN
    longest = 0
    for one in order[1:]:
        run = best = 1
        for a, b in zip(sorted(one), sorted(one)[1:]):
            run = run + 1 if b == a + 1 else 1
            best = max(best, run)
        longest = max(longest, best)
    if longest < need:
        return [None] * len(out)

    who: list[int | None] = [None] * len(out)
    for rank, one in enumerate(order):
        for index in one:
            who[index] = rank

    for index in range(1, len(who) - 1):
        left, here, right = who[index - 1], who[index], who[index + 1]
        if here is not None and left is not None and left == right and here != left:
            who[index] = left

    return who


def broken_lines(out: list[list[dict]]) -> set[int]:
    """Indices of collapsed lines — the flagged ones together with those **overlapping the line
    before**.

    @param {list[list[dict]]} out - Per-line word dicts carrying character timings.
    @returns {set[int]} Line indices that look collapsed.
    """
    hurt = {index for index, one in enumerate(out) if one and one[0].get("stuck")}
    ends = []
    for one in out:
        chars = [c for word in one for c in (word.get("chars") or [])]
        ends.append((chars[0]["at"], chars[-1]["at"]) if chars else None)
    for index, (before, now) in enumerate(zip(ends, ends[1:]), start=1):
        if before and now and now[0] < before[1]:
            hurt.add(index)
            hurt.add(index - 1)
    return hurt


def flag_stuck(lines: list[dict], out: list[list[dict]]) -> None:
    """Flag collapsed lines for a human **without using the outside times at all**. Edits `out` in
    place.

    Why this is kept separate: per-character confidence (`DOUBT`) is weak on this model — measured,
    it caught only two of five bad lines, and lowering the threshold far enough to catch four turned
    94 of 113 lines yellow. On the Korean ASR model confidence split cleanly in two (0 when right,
    below −3 otherwise), but MMS_FA's is continuous and that knife does not cut.

    Measuring against the outside line times is no good either. Confronting fifteen badly-off lines
    with the audio showed **only one** where the Vibe position was better — when the YouTube audio
    and the Naver master are different arrangements the whole song shifts, so that yardstick cannot
    tell our mistakes from a difference of release.

    So oddness is looked for **inside the alignment result only**. The sharpest test is comparing
    repeats: the same text sung in the same song should take a similar length. If
    「(If, if I got a…)」 is placed at 0.88 s one time and 10.23 s the next, the second has eaten the
    first's sound. This uses none of the outside times, so a different release does not shake it.

    Two shape tests follow. Characters all sitting **at the minimum spacing** mean the alignment
    wanted to squeeze tighter and the rules blocked it; measuring by speed instead would punish short
    lines unfairly, since three characters at nothing but the minimum spacing already read as 18
    characters a second. A gap wider than `STUCK_HOLE_MS` between characters is the second.

    Reasons are attached to the line's first word only, since the screen reads them per line.

    @param {list[dict]} lines - Lyric lines, used only to group takes of identical text.
    @param {list[list[dict]]} out - Per-line word dicts, modified in place.
    @returns {None}
    """
    from collections import defaultdict

    shape: dict[int, tuple[int, int, int]] = {}
    for index, words in enumerate(out):
        chars = [one for word in words for one in (word.get("chars") or [])]
        if len(chars) < 2:
            continue
        shape[index] = (
            len(chars),
            chars[-1]["at"] - chars[0]["at"],
            max(b["at"] - a["at"] for a, b in zip(chars, chars[1:])),
        )

    doubt: dict[int, list[str]] = defaultdict(list)

    same: dict[str, list[int]] = defaultdict(list)
    for index in shape:
        same[" ".join(lines[index].get("text", "").split())].append(index)
    for group in same.values():
        if len(group) < 2:
            continue
        spans = sorted(shape[one][1] for one in group)
        mid = spans[len(spans) // 2]
        if mid <= 0:
            continue
        for index in group:
            ratio = shape[index][1] / mid
            if ratio > STRETCH:
                doubt[index].append(f"같은 글월의 {ratio:.1f}배로 늘어남")
            elif ratio < 1 / STRETCH:
                doubt[index].append(f"같은 글월의 {ratio:.1f}배로 눌림")

    for index, (count, span, hole) in shape.items():
        if count >= 4 and span <= (count - 1) * CRAMP_MS + 20:
            doubt[index].append("글자가 모두 최소 간격에 붙음")
        if hole > STUCK_HOLE_MS:
            doubt[index].append(f"글자 사이가 {hole / 1000:.1f}초 빔")

    for index, why in doubt.items():
        for word in out[index]:
            word["shaky"] = True
        if out[index]:
            out[index][0]["stuck"] = " · ".join(why)
