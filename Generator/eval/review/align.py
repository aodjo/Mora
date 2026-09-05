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

import json
import os
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
#: Whether the line **after** a broken one is re-thought along with it.
#:
#: Breakage lives on a boundary, not in a line. Alignment is monotonic, so a line cannot be squeezed
#: without the next line's head having been placed too early — that head is what took its sound. The
#: squeezed line itself is often already sitting where it belongs, so pinning only the line the
#: detector named moves nothing.
RETHINK_NEXT = True
#: How far a song's lines may scatter around the outside clock before that clock is called tight,
#: measured as the median distance from the median offset (ms).
#:
#: This is what makes leaning on the outside times safe here. The old objection stands — when the
#: YouTube audio and the Naver master are different arrangements the whole song shifts and the
#: outside clock cannot tell our mistakes from a difference of release. But that shift moves
#: **every** line together. When sixty lines of a song sit within a fifth of a second of the clock,
#: the two that sit five seconds away are not a different arrangement.
CLOCK_TIGHT_MS = 300
#: How far from the song's own offset a line must sit, in a song whose clock is tight, before it is
#: slid back — the floor (ms), and the multiple of the measured scatter that raises it.
#:
#: A fixed 1500 ms was chosen first, well above `SUSPECT_MS`, because this correction ignores the
#: audio. It was too timid. Measured over ten songs the scatter around the clock is 0.02~0.10 s,
#: and in that world a line 0.8~1.5 s off is not a close call — 붉은 노을 kept lines at +0.78,
#: +0.83, +1.33 and +1.57 s, and 고스트시티's refrain a dozen of them, all just under the bar.
#: The limit is now `max(floor, scatter × times)`: a song whose lines sit within 70 ms of the
#: clock gets a 500 ms bar, and a looser song a proportionally looser one.
#:
#: Eight times the scatter was tried first and left 고스트시티's line 32 at +0.60 s under a 0.72 s
#: bar — six and a half times the scatter of every other line in the song is not a close call.
#: Five keeps the bar above `SUSPECT_MS` for any song this will run on (scatter ≤ 0.10 s → ≤ 0.5 s)
#: while catching that.
CLOCK_APART_LEAST_MS = 500
CLOCK_APART_TIMES = 5
#: A character this sure (log-margin against the model's own best guess; 0 is certain) counts as
#: **heard**. On MMS_FA a healthy line's best character sits around −0.2 ~ −1.0 and a passage the
#: model cannot hear at all reads −5 and below on every character, so −1.0 separates the two.
SURE_HEARD = -1.0
#: How far off the clock a line the model plainly heard may sit and still be left alone (ms).
#:
#: A rapper coming in after the beat is a fraction of a bar — 고스트시티 16 번 is 0.6 s late and
#: right. Four seconds is not a late entry, it is the wrong take of a repeated phrase, and those
#: are exactly the lines the model places with confidence in the wrong place; the clock has to win
#: there.
CLOCK_HEARD_MS = 1500
#: How many lines must carry an outside time before the clock is judged at all.
CLOCK_LEAST = 8
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

    @returns {str} One of "xpu", "cuda", "mps" or "cpu".
    """
    import torch
    if hasattr(torch, "xpu") and torch.xpu.is_available():
        return "xpu"
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


#: Which acoustic model aligns: `"mms"` (torchaudio MMS_FA, romanised) or `"kresnik"`
#: (`kresnik/wav2vec2-large-xlsr-korean`, Hangul syllables). Read from `MORA_ACOUSTIC` so the
#: probes can run both sides on the same songs without touching code.
#:
#: kresnik was the **first** model here and lost to MMS_FA on three songs (Trip: 21 broken lines
#: against 1) — see `load`. That was before the second pass, the clock, the spreading and the
#: rest existed, and on 고스트시티 line 16 it now places nine of fourteen syllables within 30 ms of a
#: measured loudness onset where MMS_FA hears three syllables at all. So it is being measured again,
#: over ten songs, with the old result kept as the warning it is.
ACOUSTIC = os.environ.get("MORA_ACOUSTIC", "mms")


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
        torch.set_num_threads(8)
        where = device()
        _bundle["where"] = where
        if ACOUSTIC == "kresnik":
            from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
            name = "kresnik/wav2vec2-large-xlsr-korean"
            proc = Wav2Vec2Processor.from_pretrained(name)
            _bundle["table"] = proc.tokenizer.get_vocab()
            _bundle["blank"] = proc.tokenizer.pad_token_id
            _bundle["unk"] = proc.tokenizer.unk_token_id
            _bundle["model"] = Wav2Vec2ForCTC.from_pretrained(name).eval().to(where)
        else:
            import torchaudio
            import uroman
            bundle = torchaudio.pipelines.MMS_FA
            _bundle["table"] = bundle.get_dict()
            _bundle["blank"] = 0
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
    if ACOUSTIC == "kresnik":
        #: One Hangul syllable is one token here, so a grain maps straight through. The
        #: vocabulary holds 1202 syllables and nothing else — no Latin, no digits — so a grain
        #: with no Hangul in it (`drug`, `24`) becomes a single `[UNK]` rather than one per letter,
        #: which would ask the model to hear four unknown things in a row.
        ids = [table[one] for one in grain if one in table]
        return ids if ids else [_bundle["unk"]]
    memo = _bundle.setdefault("said", {})
    if grain not in memo:
        memo[grain] = _bundle["roman"].romanize_string(grain).lower()
    return [table[one] for one in memo[grain] if one in table]


def inside_parens(text: str, tokenize) -> list[bool]:
    """Mark which words of a line sit inside brackets.

    Lyric sheets put backing vocals and ad-libs in brackets, so a bracketed run is sung by
    a different voice than the rest of its line. Because a lane is chosen per line, a line
    like `(If, if I got a, if I got a) would you guarantee?` was painted as one voice even
    though the bracketed half is the backing singer and the tail is the lead.

    Depth is tracked across the whole line rather than per word: an opening bracket and its
    closing partner usually land in different words, so a per-word test sees neither.

    @param {str} text - The raw line text, brackets included.
    @param {callable} tokenize - Splits the line into the same words the aligner uses.
    @returns {list[bool]} One flag per word, true when that word is inside brackets.
    """
    out: list[bool] = []
    depth = 0
    for word in tokenize(text):
        opens = sum(word.count(one) for one in "([（")
        shuts = sum(word.count(one) for one in ")]）")
        # A word carrying the opening bracket belongs to the bracketed run, and so does the
        # one carrying the closing bracket, so the flag is taken before depth drops.
        out.append(depth > 0 or opens > 0)
        depth = max(0, depth + opens - shuts)
    return out


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


#: How close together (ms) characters count as packed, for finding a run to spread.
#:
#: Deliberately wider than `CRAMP_MS`, the floor `loosen_chars` pushes characters to. Testing for
#: the floor exactly looked right and failed quietly: Bigbang's line 14 held eight syllables at 80
#: ms and then one at **81**, so the run ended there, the room measured 641 ms instead of the 4 s
#: that stood empty after the line, and nothing was spread. What is being looked for is not the
#: floor itself but a stretch nobody could sing, and the room test below is what keeps genuinely
#: fast singing safe — its next character arrives immediately, so there is nothing to spread into.
PACKED_MS = 120
#: How many characters in a row must sit packed together before the run is spread out.
CRAMP_RUN = 6
#: How many times its own width a crammed run must have free before it is spread into it.
CRAMP_ROOM = 2.0
#: The longest a single character may be given when a crammed run is spread (ms).
#:
#: Without it, a crammed line followed by an instrumental break would stretch across the whole
#: break — thirteen characters over twenty seconds. The room is only evidence that the singing
#: happened somewhere in it, not that it filled it.
SPREAD_MOST_MS = 500


def spread_crammed(chars: list[dict], roof: int | None = None) -> None:
    """Spread a run of characters stuck at the minimum spacing across the room it actually has.

    Characters sitting exactly `CRAMP_MS` apart are not a measurement. They are what is left after
    `loosen_chars` pushed them off each other: the aligner wanted to put them closer still, which
    only happens when it found no peak for any of them and dropped the whole run onto one instant.

    Two songs show the same shape. Bigbang's line 14 packed 30 characters into 1.12 s — 27 a second,
    which nobody sings — and then left 2.9 s empty before the next line. Small girl's line 18 ran
    `If, if I got a, if I got a` through in 0.78 s and held the last character for the 1.5 s cap,
    so on screen the whole phrase flashed by and then sat still. A person watching it said the
    backing singer should rest between the two takes and instead goes straight through.

    The room is real even where the placement is not: it reaches to wherever the next character
    starts, which the surrounding alignment does have evidence for. Cramming is known to be wrong,
    so an even spread across that room is taken instead — not because the singing is even, but
    because nothing here says otherwise.

    A genuinely fast line is left alone without needing a rule of its own: its next character
    arrives immediately, so there is no room to spread into and the ratio test fails.

    Scored at their own placement these passages read −12 to −16 per character against −9.5 for a
    healthy line, on the lead, backing and vocals stems alike. There is no stem where this run can
    be heard, so no better placement is available to find.

    **A run never crosses a line.** The song was first handed over as one stream so that a run at
    the end of a line could see the room before the next line — and then a run that began in the
    tail of one line and continued into the head of the next was spread as one piece from the
    earlier line's base, which **moved the later line's first character**. Bigbang's line 14 went
    from 53.72 s, on the clock, to 55.35 s, 1.7 s late, and six more lines with it; the song had
    been clean the day before. So the caller now spreads a line at a time and passes the room after
    it as `roof`, and a line's own first character never moves.

    @param {list[dict]} chars - One line's character dicts carrying "at"/"end", modified in place.
    @param {int | None} [roof=None] - Where the next line's first character starts, in ms; the
        room a run at the end of this line may spread into. None means the line's own end.
    @returns {None}
    """
    if any(one["at"] is None for one in chars):
        return
    total = len(chars)
    spot = 0
    while spot < total:
        last = spot
        while last + 1 < total and chars[last + 1]["at"] - chars[last]["at"] <= PACKED_MS:
            last += 1
        count = last - spot + 1
        #: 여섯 개 넘게 붙은 덩어리만 보면 두 가지를 놓친다. 다섯 음절짜리 줄(고스트시티의 `소외된
        #: 노예`)은 통째로 바닥에 붙어도 영영 여섯이 안 되고, 시계 맞추기가 꼬리를 자르며 한 순간에
        #: 포개 놓은 낱자들(사이 0 ms — 정렬기는 `CRAMP_MS` 아래로는 절대 안 놓는다)은 넷이면 넷인
        #: 채로 남았다. 줄 전체가 붙었거나 사이가 0 인 것이 있으면 셋만 돼도 덩어리로 친다.
        stuck_flat = any(chars[one + 1]["at"] - chars[one]["at"] <= 0 for one in range(spot, last))
        if count >= CRAMP_RUN or (count >= 3 and (count == total or stuck_flat)):
            # The room reaches to where the next character starts. The crammed run's own end is
            # not a bound — it was derived from the cramming, so taking the smaller of the two
            # would always hand back the very number being corrected.
            if last + 1 < total:
                edge = chars[last + 1]["at"]
            elif roof is not None:
                edge = roof
            else:
                edge = chars[last]["end"] or chars[last]["at"]
            base = chars[spot]["at"]
            room = min(edge - base, count * SPREAD_MOST_MS)
            if room > max(count * CRAMP_MS, chars[last]["at"] - base) * CRAMP_ROOM:
                step = room / count
                for at in range(count):
                    chars[spot + at]["at"] = int(base + step * at)
                    chars[spot + at]["end"] = int(base + step * (at + 1))
        spot = last + 1


def packed_run(chars: list[dict]) -> bool:
    """Say whether a line still holds a stretch of characters nobody could sing.

    @param {list[dict]} chars - One line's characters, in order.
    @returns {bool} True when `CRAMP_RUN` or more of them sit within `PACKED_MS` of each other.
    """
    run = 1
    for before, now in zip(chars, chars[1:]):
        #: 같은 순간에 포개진 낱자는 정렬기가 놓은 것이 아니라 잘라 낸 자국이다. 하나만 있어도
        #: 그 줄의 읽기는 못 믿는다.
        if now["at"] - before["at"] <= 0:
            return True
        run = run + 1 if now["at"] - before["at"] <= PACKED_MS else 1
        if run >= CRAMP_RUN:
            return True
    return len(chars) >= 3 and run == len(chars)


def unpack_song(out: list[list[dict]]) -> None:
    """Spread every crammed run in a song, reading the whole song as one stream of characters.

    Doing this a line at a time was not enough. When the **whole** line is crammed there is no
    later character inside it to mark where the room ends, so the run looked as though it had none
    and was left alone — Bigbang's `이 세상은 너뿐이야 (uh-huh, all in the world)` stayed at 27
    characters a second with 2.9 s standing empty after it. Read across lines, the room reaches to
    where the next line's first character starts, which is exactly the room that was empty.

    Characters that were never placed are dropped before the pass rather than stopping it.
    `spread_crammed` refuses a list holding one, which is right for a single line — a hole in the
    middle means the spacing says nothing — but across a whole song a single unplaced character
    anywhere silenced the correction for every line, and that is how it first appeared to do
    nothing at all.

    **A line still holding a packed stretch afterwards is redistributed whole.** Bigbang's line 14
    packs `이 세상은 너뿐이야` into 0.64 s and then lets `(uh-huh, all in the world)` spread over
    three seconds. Run by run there is nowhere to go — the packed stretch runs into the next
    character 861 ms later — but the line as a whole uses 1.04 s of the 4 s standing before the next
    line. A packed stretch means the model found no peaks there, and a line where part of the
    reading is that empty cannot have the rest of it trusted either, so the whole line is spread
    evenly across the room it holds.

    Only lines that still show a packed stretch are touched, which is what keeps this from undoing
    the run pass above: Small girl's line 18 has its bracketed run spread out by then and its
    `would you guarantee?` keeps the placement it earned.

    **This runs last, after everything that trims.** `settle_clock` cuts a tail that reaches over
    the line it slid back, and `settle_lanes` cuts one that reaches over the next line of the same
    voice, and both do it by pulling characters onto a single instant. Spreading before them left
    Bigbang's chorus packed again on the screen while every measurement taken inside `align_song`
    said it had been fixed — the correction was real and then quietly undone downstream.

    @param {list[list[dict]]} out - Per-line word dicts, modified in place.
    @returns {None}
    """
    mine = [[one for word in words for one in (word.get("chars") or []) if one["at"] is not None]
            for words in out]
    after = [chars[0]["at"] for chars in mine if chars]
    #: 줄마다 따로 편다. 곡을 한 줄기로 넘기면 앞줄 꼬리와 붙은 덩어리가 줄 경계를 넘어 다음 줄
    #: 첫 낱자를 뒤로 밀어낸다 — 붉은 노을 14 번이 그렇게 1.7 초 늦어졌다. 방은 다음 줄이 시작하는
    #: 데까지로 그대로 주되, 줄의 첫 낱자는 절대 안 움직인다.
    for chars in mine:
        if not chars:
            continue
        later = [one for one in after if one > chars[0]["at"]]
        spread_crammed(chars, min(later) if later else None)
    for chars in mine:
        #: 여기도 여섯 개 문이 있었다. 고스트시티 67 번 `소외된 노예` 는 낱자 다섯 — 첫 낱자 뒤 2.1 초가
        #: 비고 나머지 넷이 한 순간에 포개져 있는데, 다섯이라 줄째 나누는 길에 못 들어와 그대로 남았다.
        #: 붙었는지는 `packed_run` 이 가리고, 여기서는 나눌 만한 수(셋)만 본다.
        if len(chars) < 3 or not packed_run(chars):
            continue
        base = chars[0]["at"]
        later = [one for one in after if one > base]
        roof = min([one for one in later] + [chars[-1]["end"] or chars[-1]["at"]])
        room = min(roof - base, len(chars) * SPREAD_MOST_MS)
        if room <= 0:
            continue
        step = room / len(chars)
        for at, one in enumerate(chars):
            one["at"] = int(base + step * at)
            one["end"] = int(base + step * (at + 1))

    #: 외로운 머리. 못이 줄 머리를 바이브 자리에 박으면 첫 낱자만 거기 남고 나머지는 모델이 들은
    #: 자리로 간다 — 고스트시티 16 번 `근본적인 속부터…` 은 「근」이 64.05 초에 홀로 서고 「본」은
    #: 0.92 초 뒤에 오며, 확신도가 「근」 −5.8, 「본」 −0.76 이다. 사람은 「근」만 한 박 먼저 켜졌다가
    #: 멈추는 것으로 본다(「1:04 가 이상하게 처리되었어」). 열 곡에서 열두 줄, 전부 랩이다.
    #:
    #: 줄 몸통의 보통 틈보다 세 배 넘게(그리고 0.5 초 넘게) 떨어져 있고 **확신도도 몸통의 가운뎃값
    #: 아래**인 첫 낱자만 몸통 바로 앞으로 붙인다. 길게 끄는 진짜 첫 음절은 확신도가 세어서 안 걸린다.
    for chars in mine:
        if len(chars) < 4:
            continue
        gaps = [chars[at + 1]["at"] - chars[at]["at"] for at in range(len(chars) - 1)]
        rest = sorted(gaps[1:])
        usual = rest[len(rest) // 2]
        sures = sorted(one.get("sure", -9.0) for one in chars)
        if gaps[0] <= max(500, usual * 3) or chars[0].get("sure", -9.0) >= sures[len(sures) // 2]:
            continue
        chars[0]["at"] = chars[1]["at"] - max(LEAST_MS, usual)
        chars[0]["end"] = chars[1]["at"]

    for words in out:
        for word in words:
            got = [one for one in (word.get("chars") or []) if one["at"] is not None]
            if got:
                word["at"] = got[0]["at"]
                word["end"] = max(max(one["end"] for one in got), got[0]["at"] + LEAST_MS)


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
            fed = voice[..., left:right].to(where)
            #: torchaudio's model hands back `(probabilities, lengths)`; the transformers build
            #: hands back an object whose `.logits` is the same tensor. Both are 20 ms a frame.
            got = (model(fed).logits if ACOUSTIC == "kresnik" else model(fed)[0]).cpu()
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

    apart = Separator(output_dir=str(work), output_format="WAV", log_level=40, **FASTER)
    #: `audio-separator` 는 cuda·mps·directml 만 본다. Arc 는 못 알아보고 CPU 로 떨어져 네 배짜리
    #: 곡이 20 분 51 초 걸렸다 — 여기서 직접 물려 4 분이 됐다.
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
        paths, scores = F.forced_align(piece, torch.tensor([tokens]), blank=_bundle.get("blank", 0))
    except Exception:
        return None
    merged = F.merge_tokens(paths[0], scores[0], blank=_bundle.get("blank", 0))
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
    hole = STUCK_HOLE_MS / per_frame
    broken = set()
    for index in reach:
        start, stop, count = reach[index]
        before = reach.get(index - 1)
        if before and start < before[1]:
            broken.add(index)
            broken.add(index - 1)
        if count >= 4 and (stop - start) <= (count - 1) * floor + 1:
            broken.add(index)

    for index, head in enumerate(heads):
        if head is None or not spans[index]:
            continue
        mine = merged[head: head + spans[index]]
        if any(b.start - a.start > hole for a, b in zip(mine, mine[1:])):
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
        if mid > 0 and mine * STRETCH < mid:
            broken.add(index)

    if RETHINK_NEXT:
        for index in sorted(broken):
            if index + 1 in reach:
                broken.add(index + 1)

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


def settle_clock(lines: list[dict], out: list[list[dict]]) -> None:
    """Slide a stray line back onto the song's own clock. Edits `out` in place.

    Measuring against the outside line times was ruled out early and for a good reason: confronting
    fifteen badly-off lines with the audio showed **only one** where the outside position was
    better, because a YouTube upload and the Naver master are often different arrangements and then
    the whole song shifts. That objection is about a shift that moves **every line together**, and it
    is exactly what this function tests for before doing anything.

    The song's offset is taken as the median distance between our starts and the outside times, and
    the scatter around it as the median absolute deviation. A wide scatter means the two clocks
    disagree and nothing is touched. A tight scatter means the audio really is the same take, and
    then a line sitting seconds away from a clock the other sixty lines agree with is our error.

    Small girl is the case this was written for. Its lines 20 and 62 are the third repeat of
    `(If, if I got a, if I got a)`, and both landed about five seconds late — `+5.22 s` and
    `+4.81 s` — while all sixty other lines sat within `±0.2 s`. The model has no say there: scored
    at its own placement the passage reads −19 against −9.5 for a healthy line, and eighteen vocal
    models were measured discarding this same passage. Two lines failing the same way in the same
    place of a repeated verse is a pattern, not two judgements.

    The line is moved **whole**, keeping the spacing inside it, and never past where the line before
    it starts or where the line after it starts. Anything that will not fit is left alone.

    A line that has been stretched can cover the room its neighbour needs, and at first that counted
    as no room and blocked the move — 5 of the 7 stray lines were held by a tail, not by a voice.
    A tail that reaches over the moved line is trimmed back instead, the same trimming
    `settle_lanes` does for two lines of one voice. Only the tail moves; a line's own start is never
    crossed, so nothing is swallowed.

    @param {list[dict]} lines - Lyric lines carrying the outside start times.
    @param {list[list[dict]]} out - Per-line word dicts, modified in place.
    @returns {None}
    """
    edge: dict[int, tuple[int, int]] = {}
    for index, words in enumerate(out):
        chars = [one for word in words for one in (word.get("chars") or [])]
        if chars:
            edge[index] = (chars[0]["at"], max(one["end"] or one["at"] for one in chars))

    off = [edge[index][0] - lines[index]["at"] for index in edge
           if lines[index].get("at") is not None]
    if len(off) < CLOCK_LEAST:
        return
    mid = sorted(off)[len(off) // 2]
    apart = sorted(abs(one - mid) for one in off)
    scatter = apart[len(apart) // 2]
    if scatter > CLOCK_TIGHT_MS:
        return
    limit = max(CLOCK_APART_LEAST_MS, scatter * CLOCK_APART_TIMES)

    #: 시계 맞추기는 **모델이 못 들은 줄**을 위한 것이다. 모델이 확신을 갖고 놓은 줄까지 끌면
    #: 그 확신을 버리는 셈이다 — 고스트시티 16 번은 「본」이 −0.76 으로 64.97 초에 또렷한데, 외로운
    #: 머리를 몸통에 붙이자 줄 시작이 시계에서 0.67 초 떨어졌고, 그걸 튄 줄로 보아 통째로 64.04 초로
    #: 끌어와 「본」이 64.35 초가 됐다. 래퍼가 박자 뒤에 들어온 것이지 우리가 틀린 것이 아니다.
    #: 「확신도 가운뎃값이 곡의 가운뎃값 이상이면 믿는다」로 먼저 해 봤다가 물렸다. 되풀이 구절은
    #: **확신 있게 틀린 자리**에 놓이므로 그 문을 63 번(−4.59 초)과 파란달팽이 3·4 번(−14.5 초)까지
    #: 통과했고, 고스트시티의 튄 줄이 0 에서 16 으로 돌아갔다. 32 번(틀림, +0.60)과 16 번(맞음, +0.6)을
    #: 실제로 가르는 것은 다르다 — 32 번은 낱자가 전부 바닥에 붙어 있었고 16 번에는 「본」 −0.76,
    #: 「나」 −0.24 처럼 **거의 확실한** 낱자가 있다. 그런 낱자가 하나라도 있고, 어긋남이 박자 뒤에
    #: 들어온 만큼(한 박 안)일 때만 제자리를 믿는다. 4 초는 늦게 들어온 것이 아니라 딴 자리다.
    heard: dict[int, float] = {}
    for index, words in enumerate(out):
        got = [one.get("sure", -9.0) for word in words for one in (word.get("chars") or [])
               if one["at"] is not None]
        if got:
            heard[index] = max(got)

    order = sorted(edge)
    for spot, index in enumerate(order):
        if lines[index].get("at") is None:
            continue
        since, until = edge[index]
        want = lines[index]["at"] + mid
        if abs(since - want) <= limit:
            continue
        if heard.get(index, -9.0) >= SURE_HEARD and abs(since - want) <= CLOCK_HEARD_MS:
            continue
        #: 방의 경계는 옆 줄의 **시계 자리**다. 옆 줄의 지금 자리로 막으면, 한 대목의 여러 줄이 함께
        #: 밀려 있을 때 서로가 서로를 막아 아무도 못 움직인다 — 고스트시티 24 번은 25 번이 0.29 초
        #: 일찍 놓여 있어서 제자리로 못 갔고, 25 번은 24 번 꼬리에 막혔다. 시계가 좁다고 이미 판정한
        #: 곡이므로 옆 줄이 진짜로 시작하는 자리는 그 줄의 시계 자리다. 시각이 없는 줄만 지금 자리를 쓴다.
        before = order[spot - 1] if spot else None
        after = order[spot + 1] if spot + 1 < len(order) else None
        floor = 0
        if before is not None:
            floor = (lines[before]["at"] + mid if lines[before].get("at") is not None
                     else edge[before][0]) + LEAST_MS
        roof = want + (until - since)
        if after is not None:
            roof = (lines[after]["at"] + mid if lines[after].get("at") is not None
                    else edge[after][0]) - LEAST_MS
        #: 늘어난 줄은 늘어난 채로는 방에 안 들어간다. 고스트시티 24 번 `소외된 노예` 는 2.12 초로
        #: 잡혀 있었고(다른 열한 번은 0.4~1.6 초) 바이브 자리로 옮기면 꼬리가 다음 줄을 덮어 못
        #: 옮겼다 — 그러면서 앞뒤 세 줄이 같이 틀린 채 남았다. 그 꼬리는 `flag_stuck` 이 「늘어남」
        #: 이라 부르는 바로 그것이라 증거가 아니다. 방에 맞게 잘라 넣고, 몰린 것은 뒤의 `unpack_song`
        #: 이 편다.
        #: 방은 **시계 자리에서** 다음 줄의 시계 자리까지다. 동네 전체(앞줄부터 뒷줄까지)로 재면
        #: 늘어난 길이가 그대로 통과한다 — 24 번은 2.12 초가 2.8 초 방에 들어가니 자르지 않았고,
        #: 그 길이로는 시계 자리(다음 줄까지 1.27 초)에 못 들어가 다시 뒤로 밀려 제자리에 남았다.
        want = max(floor, want)
        span = min(until - since, max(LEAST_MS, roof - want))
        want = max(floor, min(want, roof - span))
        if want < floor or abs(want - since) <= limit:
            continue
        move = want - since
        stop = want + span
        for word in out[index]:
            for grain in word.get("chars") or []:
                grain["at"] = min(grain["at"] + move, stop - 20)
                if grain["end"] is not None:
                    grain["end"] = max(grain["at"] + 20, min(grain["end"] + move, stop))
            got = word.get("chars") or []
            if got:
                word["at"] = got[0]["at"]
                word["end"] = max(one["end"] for one in got)
            else:
                word["at"] += move
                word["end"] += move
        edge[index] = (want, stop)

        if before is not None and edge[before][1] > want:
            for word in out[before]:
                for grain in word.get("chars") or []:
                    if grain["at"] >= want:
                        grain["at"] = max(edge[before][0], want - LEAST_MS)
                    grain["end"] = max(grain["at"] + 20, min(grain["end"] or grain["at"], want))
                got = word.get("chars") or []
                if got:
                    word["at"] = got[0]["at"]
                    word["end"] = max(one["end"] for one in got)
            edge[before] = (edge[before][0], want)

    #: 시작이 다 제자리에 온 뒤에도 **끝**이 다음 줄을 넘어 늘어난 줄이 남는다. 고스트시티의
    #: 후렴 `소외된 노예` 는 열두 번 가운데 0.4 초짜리와 2.24 초짜리가 같이 있었고, 늘어난 쪽은
    #: 꼬리가 다음 줄 시계 자리를 덮고 있었다. 되풀이 짝의 가운뎃값보다 `STRETCH` 배 넘게 길고
    #: **동시에** 꼬리가 다음 줄의 시계 자리를 넘는 줄만 거기서 자른다 — 증거 둘이 같은 말을 할
    #: 때만이라, 다른 목소리와 겹쳐 길게 끄는 진짜 이중창 줄은 짝과 어긋나지 않는 한 안 건드린다.
    #: 길이는 `flag_stuck` 과 같은 자로 잰다 — 첫 낱자 시작에서 **끝 낱자 시작**까지. 끝 낱자의 끝까지
    #: 재면 `loosen_chars` 가 다음 낱자까지 늘려 둔 꼬리가 다 들어가 짝의 가운뎃값이 부풀고, 2.0 배로
    #: 잡힌 줄이 1.8 배 문턱을 통과해 하나도 안 잘렸다.
    said_text = [" ".join(one.get("text", "").split()) for one in lines]
    reach: dict[int, int] = {}
    for index, words in enumerate(out):
        chars = [one for word in words for one in (word.get("chars") or []) if one["at"] is not None]
        if chars:
            reach[index] = chars[-1]["at"] - chars[0]["at"]
    twins: dict[str, list[int]] = {}
    for index in reach:
        if said_text[index]:
            twins.setdefault(said_text[index], []).append(index)
    for spot, index in enumerate(order):
        mates = [one for one in twins.get(said_text[index], []) if one != index and one in reach]
        if len(mates) < 2 or spot + 1 >= len(order) or index not in reach:
            continue
        after = order[spot + 1]
        if lines[after].get("at") is None:
            continue
        widths = sorted(reach[one] for one in mates)
        typical = widths[len(widths) // 2]
        since, until = edge[index]
        stop = lines[after]["at"] + mid - LEAST_MS
        if typical <= 0 or reach[index] <= typical * STRETCH or until <= stop or stop <= since + LEAST_MS:
            continue
        for word in out[index]:
            for grain in word.get("chars") or []:
                grain["at"] = min(grain["at"], stop - 20)
                grain["end"] = max(grain["at"] + 20, min(grain["end"] or grain["at"], stop))
            got = word.get("chars") or []
            if got:
                word["at"] = got[0]["at"]
                word["end"] = max(one["end"] for one in got)
        edge[index] = (since, stop)


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
            paths, scores = F.forced_align(piece, torch.tensor([piece_tokens]), blank=_bundle.get("blank", 0))
        except Exception:
            return None
        got = F.merge_tokens(paths[0], scores[0], blank=_bundle.get("blank", 0))
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
    blank = _bundle.get("blank", 0)

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
    for where, rows in enumerate(plan):
        mask = inside_parens(lines[where].get("text", ""), tokenize)
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
        for spot, size in enumerate(shape):
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
                **({"back": True} if spot < len(mask) and mask[spot] else {}),
                "chars": chars,
            })
        out.append(words_out)
    settle_clock(lines, out)
    unpack_song(out)
    flag_stuck(lines, out)
    return out


def in_order(out: list[list[dict]], index: int, now: list[dict]) -> bool:
    """Say whether a candidate placement for one line keeps the song in order.

    A single alignment is monotonic by construction. Choosing each line from **four** of them
    is not: line 85 of 고스트시티 came from one stem at 202.94 s and line 86 from another at
    200.22 s, so the refrain read backwards. The distance guards let it through — 4 s of reach is
    plenty of room to land a short line on the wrong side of its neighbour — and nothing after
    the choice puts lines back in order. `settle_clock` then worked from neighbours taken by
    index, bounding a line by another that was itself out of place.

    The rule is the one every alignment already obeys: a line starts no earlier than the line
    before it and no later than the line after it. The base alignment is in order, and every
    swap is checked against the state as it stands, so the order holds by induction.

    @param {list[list[dict]]} out - Per-line word dicts as they stand.
    @param {int} index - Which line the candidate is for.
    @param {list[dict]} now - The candidate's characters, in order.
    @returns {bool} True when the candidate sits between its neighbours.
    """
    since = now[0]["at"]
    for before in range(index - 1, -1, -1):
        chars = [one for word in out[before] for one in (word.get("chars") or [])]
        if chars:
            if since < chars[0]["at"]:
                return False
            break
    for after in range(index + 1, len(out)):
        chars = [one for word in out[after] for one in (word.get("chars") or [])]
        if chars:
            return since <= chars[0]["at"]
    return True


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
            if not in_order(out, index, now):
                continue
            out[index] = got

    who = who_sings(lead, path, lines, out, title)
    for index, one in enumerate(who):
        if one:
            lanes[index] = one
    split_runs(voices_apart(path), lines, out, who, tokenize)

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
            if not in_order(out, index, now):
                continue
            out[index] = got

    settle_lanes(out, lanes)
    #: 시계 맞추기는 갈래마다의 `align_song` 안에서 돌지만, 그 뒤에 네 갈래에서 줄을 골라 섞으면
    #: 그때 새로 튀는 줄이 생긴다 — 고스트시티 63 번이 −4.59 초로 남아 있었다(`RESCUE_REACH_MS`
    #: 4 초 안이라 고르기는 통과한다). 섞은 뒤의 최종 결과에 한 번 더 건다.
    settle_clock(lines, out)
    unpack_song(out)

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
#: How long (ms) a bracketed run inside a line must be before its own voice print is taken.
#:
#: Lower than `VOICE_LEAST_MS` on purpose: these runs are short by nature — Small girl's
#: `(If, if I got a, if I got a)` lasts about 1.4 s and its tail `would you guarantee?` about
#: 1.1 s, and requiring a full second of each would throw away most of the very lines this is
#: for. The run is only ever matched against clusters that whole lines already built, never used
#: to build one, so a shaky short print can pick the wrong side but cannot move the clusters.
VOICE_PART_MS = 500
#: Which stem the runs inside a line are read from — `"lead"`, `"back"` or `"vocals"`.
#:
#: Kept apart from the stem whole lines are read from because the two ask different questions. A
#: whole line is asking who its singer is, and the lead stem answers that best. A run inside a line
#: is asking whether **this piece** is a different voice from the piece beside it, and the lead stem
#: is the worst place to ask: the karaoke split exists to push the backing voice out of it, so the
#: bracketed backing run and the lead tail next to it come out looking alike. The vocals stem still
#: holds both voices and is where the two pieces stay different.
#:
#: Whichever is chosen, the cluster centres the runs are matched against are rebuilt in that same
#: stem — a distance between prints taken from different files measures the file, not the person.
#:
#: Measured against the four Small girl lines a person split by ear, with the pattern spread on:
#:
#:   lead   — 3/4, and line 19 comes out the mirror image of line 18
#:   back   — 0/4, nothing splits at all
#:   vocals — **4/4, no false hits**, and none of the five solo songs split a line
VOICE_PART_FROM = "vocals"
#: Whether a line that split is copied onto other lines carrying the very same words.
#:
#: Summing the prints of same-worded runs before matching was tried first and was worse: the sum
#: pulled both runs of Small girl's lines 18~19 onto one cluster and **the split disappeared**
#: (2 lines → 0). Copying the finished pattern instead leaves each decision where it was made and
#: only fills in the lines that failed to decide.
VOICE_PART_SPREAD = True
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
#: Half precision and a compiled graph, both handed to `audio-separator`.
#:
#: These are only checked for the Roformer families, which is exactly what both models above are.
#: Separation is where nearly all the time goes — measured on an M5 Pro for a 3:10 song:
#:
#:   보컬 분리 (BS-Roformer)     237.8 초 → fp16 149.8 → 컴파일 178.9 → **둘 다 89.5**
#:   리드·서브 (Mel-Band)        101.5 초 → fp16  69.3 → 컴파일  68.7 → **둘 다 40.2**
#:
#: The sound does not change: against the fp32 result the largest sample difference was 0.004 and
#: the loudness ratio 1.0000. Turning only one of the two on is worth little; the pair is what
#: makes the difference, and together they take a song from 5 분 45 초 to 2 분 16 초.
FASTER = {"use_native_fp16": True, "use_torch_compile": True}


#: Where the diarizer lives. It needs torch 2.8 and the aligner is pinned to 2.7 by `torchaudio`
#: and MMS_FA, so it gets a home of its own; putting them together made pip pull torch 2.13 and
#: break `torchvision` outright.
DIARIZE_PY = Path.home() / "dia/bin/python"
#: How much of a line one voice must hold before it counts as singing it.
#:
#: A breath caught at the edge of a neighbouring line would otherwise make every line a duet.
VOICE_SHARE = 0.2


def voices_apart(path: Path) -> dict:
    """Ask the diarizer who sings when, cached beside the audio.

    Runs `diarize.py` in its own environment and keeps the answer in a `.dia.json` next to the
    stem, so a song is only ever diarized once.

    @param {Path} path - The original audio; the vocals stem is what actually gets read.
    @returns {dict} The diarizer's answer, or an empty dict when it could not be run.
    """
    stem = vocals_of(path)
    into = stem.with_suffix(".dia.json")
    if into.exists():
        try:
            return json.loads(into.read_text(encoding="utf-8"))
        except Exception:
            into.unlink(missing_ok=True)
    if not DIARIZE_PY.exists():
        return {}
    subprocess.run([str(DIARIZE_PY), str(Path(__file__).parent / "diarize.py"),
                    str(stem), str(into)], check=False, capture_output=True)
    if not into.exists():
        return {}
    try:
        return json.loads(into.read_text(encoding="utf-8"))
    except Exception:
        return {}


def held_by(said: dict, since: float, until: float) -> dict[int, float]:
    """Measure how much of a stretch each voice holds.

    @param {dict} said - The diarizer's answer.
    @param {float} since - Start of the stretch, in seconds.
    @param {float} until - End of the stretch, in seconds.
    @returns {dict[int, float]} Share of the stretch held, per voice.
    """
    room = max(0.001, until - since)
    held: dict[int, float] = {}
    for one in said.get("쪽", []):
        for a, b in one["토막"]:
            over = min(until, b) - max(since, a)
            if over > 0:
                held[one["누구"]] = held.get(one["누구"], 0.0) + over / room
    return held


def split_runs(said: dict, lines: list[dict], out: list[list[dict]],
               who: list[int | None], tokenize) -> None:
    """Give a bracketed run inside a line its own voice, when the diarizer hears a different one.

    Lyric sheets write `(If, if I got a, if I got a) would you guarantee?` as one line, where the
    bracketed run is the backing singer and the tail is the lead. A lane per line paints the whole
    thing one colour, which is the thing a person kept pointing at.

    Brackets decide **where to cut**, never **who it is** — sheets bracket the same singer's own
    doubling just as often, so reading a bracket as "this is the backing singer" would be a guess.
    The diarizer is asked about each run on its own, and a line is only repainted when its runs come
    back as different voices.

    This replaces matching a voice print of the run against cluster centres. A run is around a
    second long and a print that short wobbled badly — the same words on lines 18 and 19 came out
    as mirror images of each other, so one of them had to be wrong. Nothing is being compared here;
    the diarizer already says who is on at that moment.

    @param {dict} said - The diarizer's answer for this song.
    @param {list[dict]} lines - Lyric lines, read for their brackets.
    @param {list[list[dict]]} out - Per-line word dicts, marked in place with `word["lane"]`.
    @param {list[int | None]} who - Voice per line, used to number the runs the same way.
    @param {callable} tokenize - Splits a line into the words the aligner used.
    @returns {None}
    """
    if not said.get("쪽"):
        return
    rank = {}
    for index, one in enumerate(who):
        chars = [two for word in out[index] for two in (word.get("chars") or [])]
        if one is None or not chars:
            continue
        held = held_by(said, chars[0]["at"] / 1000, chars[-1]["end"] / 1000)
        if held:
            rank[max(held, key=lambda two: held[two])] = one

    for index, words in enumerate(out):
        if not words or not any(word.get("back") for word in words):
            continue
        runs, mine = [], []
        for word in words:
            if mine and bool(word.get("back")) != bool(mine[0].get("back")):
                runs.append(mine)
                mine = []
            mine.append(word)
        if mine:
            runs.append(mine)
        if len(runs) < 2:
            continue

        said_as = []
        for run in runs:
            chars = [one for word in run for one in (word.get("chars") or [])]
            held = held_by(said, chars[0]["at"] / 1000, chars[-1]["end"] / 1000) if chars else {}
            said_as.append(rank.get(max(held, key=lambda one: held[one])) if held else None)
        if len({one for one in said_as if one is not None}) < 2:
            continue
        for run, lane in zip(runs, said_as):
            if lane is None:
                continue
            for word in run:
                word["lane"] = lane


def told_apart(said: dict, out: list[list[dict]]) -> list[int | None]:
    """Read a line's singer straight off the diarizer, and mark where two of them sound at once.

    Sortformer answers a different question from the embedding clustering below, and a better one.
    Clustering asks "which of these voice prints look alike", and on singing that is a weak
    question — ECAPA is trained on speech and one person's print moves a great deal with pitch and
    delivery, so **three of the five solo songs were split into two singers**. Sortformer is trained
    to say, frame by frame, whether each person is singing, so nothing is being compared: four of
    the five solo songs come back as one voice.

    It also answers something the old measurement could not express at all. A print per line means
    one singer per line, so a passage sung by two people **at the same time** had nowhere to go.
    Here two voices are simply on together, and Small girl's lines 19 and 60 — the
    `(If, if I got a, if I got a) would you guarantee?` a person pointed at — come back as
    overlapping, which is exactly what they sound like.

    Voices are renumbered so the one holding the most lines is 0; if the numbering moved from song
    to song the screen would be unreadable. A line where a second voice holds at least
    `VOICE_SHARE` of it carries that voice in `words[0]["with"]`.

    @param {dict} said - The diarizer's answer for this song.
    @param {list[list[dict]]} out - Per-line word dicts, marked in place with any second voice.
    @returns {list[int | None]} Singer index per line, or None where nobody was heard.
    """
    who: list[int | None] = [None] * len(out)
    seconds: list[dict[int, float]] = []
    for words in out:
        chars = [one for word in words for one in (word.get("chars") or [])]
        seconds.append(held_by(said, chars[0]["at"] / 1000, chars[-1]["end"] / 1000)
                       if chars else {})

    tally: dict[int, int] = {}
    for held in seconds:
        best = max(held, key=lambda one: held[one]) if held else None
        if best is not None:
            tally[best] = tally.get(best, 0) + 1
    order = {one: rank for rank, one in
             enumerate(sorted(tally, key=lambda one: -tally[one]))}
    if len(order) < 2:
        return [0 if held else None for held in seconds]

    for index, held in enumerate(seconds):
        if not held:
            continue
        best = max(held, key=lambda one: held[one])
        who[index] = order.get(best, 0)
        beside = [one for one in held
                  if one != best and held[one] >= VOICE_SHARE and one in order]
        if beside and out[index]:
            out[index][0]["with"] = order[max(beside, key=lambda one: held[one])]
    return who


def who_sings(stem: Path, path: Path, lines: list[dict], out: list[list[dict]],
              title: str) -> list[int | None]:
    """Decide **who sings** each line: 0 = the singer with the most lines, 1·2 = the rest, None
    when it cannot be decided.

    Sortformer answers this now — see `told_apart`. Everything below is the fallback for a machine
    without the diarizer's environment, and is kept because the reasoning in it was expensive to
    reach and still explains what does and does not work on singing.

    What the karaoke model separates is "lead against harmony", not **who**. A featured singer sings
    lead alone, so they land in the lead stem untouched and no split happens even though the voice
    changes plainly — that is exactly what the user pointed out. This is a different measurement
    from the backing-stem rescue in `align_voices`: that one asks "is this harmony", this one asks
    "who is it".

    To separate people, a **speaker embedding** is taken per voice and similar ones are clustered.
    `speechbrain`'s ECAPA-TDNN is used, and the embeddings are taken **per line** — the usual
    approach of sweeping a window over the audio to find speaker boundaries is unnecessary because
    we already know where every line starts and ends. The stem is read exactly once; reading per
    line would decode the same file dozens of times.

    **Every print comes from one stem, the lead one.** Taking each line's print from whichever stem
    that line happened to align on sounds more faithful and was tried, but a cluster is a comparison
    of distances, and prints from different stems are not comparable — the karaoke split leaves its
    own colouring on each, so two lines land far apart for having been read from different files
    rather than for being different people. Measured against the six lines a person picked out by
    ear on Small girl, and against whether Bigbang's members separate at all:

      each line's own stem — 4/6, and 붉은 노을 does not split at all
      lead stem           — **6/6, no false hits, and 붉은 노을 splits into 34/13/1**
      backing stem        — 6/6 but two extra lines, and 붉은 노을 does not split
      vocals stem         — 6/6, but 붉은 노을 does not split

    The lead stem wins on both counts and costs one file read instead of three. It also keeps the
    solo songs no worse: three of the five split either way.

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

    **The voice also changes inside a line.** Small girl writes
    `(If, if I got a, if I got a) would you guarantee?` as one line, where the bracketed run is the
    backing singer and the tail is the lead — but a lane per line painted the whole thing one
    colour. So after the clusters exist, any line carrying a bracketed run has a print taken for
    **each run** and matched to the nearest cluster centre, and the words keep that lane in
    `word["lane"]`.

    Brackets decide **where to cut**, never **who it is**. Reading a bracket as "this is the backing
    singer" would be one more title-shaped guess like the `Feat.` rule above — lyric sheets bracket
    the same singer's own doubling just as often. Here the print still answers who, so a bracket
    sung by the same person lands in the same cluster and the line stays one colour. A line is only
    repainted when its runs land in **different** clusters, which also means this can never split a
    song the line-level pass declared a solo.

    **A line that splits is copied onto other lines carrying the very same words.** These runs are
    around a second long and a print that short wobbles: Small girl writes `(If, if I got a, if I
    got a) would you guarantee?` as lines 18, 19, 60 and 61, letter for letter the same, and decided
    one at a time only line 18 came out right. Summing their prints before matching was tried first
    and was worse — the sum pulled both runs onto one cluster and **the split vanished**, 2 lines to
    0. Copying the finished pattern instead leaves every decision where it was made and only fills
    in the lines that failed to decide: 1/4 becomes 4/4 with no false hits.

    This is not the majority vote rejected above. Nothing counts which answer is more common; a line
    that reached no split takes the pattern of one that did, and a line that already split keeps its
    own.


    The line's own lane then follows its **longest** run, so the timeline agrees with the lyric.

    @param {Path} stem - The lead stem every whole-line voice print is taken from.
    @param {Path} path - The original audio, used to name the other stems.
    @param {list[dict]} lines - Lyric lines, unused for timing here.
    @param {list[list[dict]]} out - Per-line word dicts carrying character timings.
    @param {str} title - Song title, used as a weak hint that several singers exist.
    @returns {list[int | None]} Singer index per line, or None where undecided.
    """
    said = voices_apart(path)
    if said.get("쪽"):
        return told_apart(said, out)

    import torch
    from sklearn.cluster import AgglomerativeClustering

    if "voice" not in _bundle:
        from speechbrain.inference.speaker import EncoderClassifier
        _bundle["voice"] = EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            savedir=str(Path(__file__).parent / "models/ecapa"),
            run_opts={"device": device()})
    model = _bundle["voice"]

    audio = read_audio(stem)[0]

    least = VOICE_LEAST_MS / 1000 * SAMPLE_RATE
    where, marks = [], []
    with torch.inference_mode():
        for index, words in enumerate(out):
            chars = [one for word in words for one in (word.get("chars") or [])]
            if not chars:
                continue
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

    close = {"lead": stem, "back": path.with_suffix(".back.wav"),
             "vocals": path.with_suffix(".vocals.wav")}.get(VOICE_PART_FROM, stem)
    if close != stem and close.exists():
        audio = read_audio(close)[0]
        with torch.inference_mode():
            for spot, index in enumerate(where):
                chars = [one for word in out[index] for one in (word.get("chars") or [])]
                since = int(chars[0]["at"] / 1000 * SAMPLE_RATE)
                until = int((chars[-1]["end"] or chars[-1]["at"]) / 1000 * SAMPLE_RATE)
                if since < 0 or until > audio.shape[-1] or until <= since:
                    continue
                mark = model.encode_batch(
                    audio[since:until].unsqueeze(0).to(device())).squeeze().cpu()
                stack[spot] = mark / mark.norm().clamp(min=1e-9)

    middles = []
    for one in order:
        rows = torch.stack([stack[where.index(index)] for index in one]).mean(dim=0)
        middles.append(rows / rows.norm().clamp(min=1e-9))
    middle = torch.stack(middles)

    torn: list[tuple[int, list[list[dict]], list[object]]] = []
    with torch.inference_mode():
        for index, words in enumerate(out):
            if who[index] is None or not any(word.get("back") for word in words):
                continue
            runs, mine = [], []
            for word in words:
                if mine and bool(word.get("back")) != bool(mine[0].get("back")):
                    runs.append(mine)
                    mine = []
                mine.append(word)
            if mine:
                runs.append(mine)
            if len(runs) < 2:
                continue

            said = []
            for run in runs:
                since = int(run[0]["at"] / 1000 * SAMPLE_RATE)
                until = int(run[-1]["end"] / 1000 * SAMPLE_RATE)
                if until - since < VOICE_PART_MS / 1000 * SAMPLE_RATE \
                        or since < 0 or until > audio.shape[-1]:
                    said.append(None)
                    continue
                mark = model.encode_batch(
                    audio[since:until].unsqueeze(0).to(device())).squeeze().cpu()
                said.append(mark / mark.norm().clamp(min=1e-9))
            torn.append((index, runs, said))

    said_as = [[None if mark is None else int((middle @ mark).argmax()) for mark in said]
               for _, _, said in torn]

    if VOICE_PART_SPREAD:
        shape: dict[str, list[int | None]] = {}
        for (index, runs, _), lanes in zip(torn, said_as):
            if len({one for one in lanes if one is not None}) > 1:
                shape.setdefault(" ".join(word["text"] for word in
                                          [one for run in runs for one in run]), lanes)
        for spot, ((index, runs, _), lanes) in enumerate(zip(torn, said_as)):
            if len({one for one in lanes if one is not None}) > 1:
                continue
            same = shape.get(" ".join(word["text"] for word in
                                      [one for run in runs for one in run]))
            if same and len(same) == len(lanes):
                said_as[spot] = list(same)

    for (index, runs, _), lanes in zip(torn, said_as):
        if len({one for one in lanes if one is not None}) < 2:
            continue
        for run, lane in zip(runs, lanes):
            if lane is None:
                continue
            for word in run:
                word["lane"] = lane
        widest = max((one for one in zip(runs, lanes) if one[1] is not None),
                     key=lambda one: one[0][-1]["end"] - one[0][0]["at"])
        who[index] = widest[1]

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
