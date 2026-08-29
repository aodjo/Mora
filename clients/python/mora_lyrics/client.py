"""Mora 공개 정렬 API 클라이언트."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from bisect import bisect_right
from dataclasses import dataclass, field
from typing import Any, Iterator, Literal, Sequence

DEFAULT_BASE_URL = "https://mora.junx.dev"
DEFAULT_TIMEOUT = 15.0

Tier = Literal["word", "word-approx", "line", "none"]
Format = Literal["spans", "lrc-a2", "lyricsfile", "ttml", "webvtt"]


class MoraError(RuntimeError):
    """서버가 요청을 받아들이지 않았다."""

    def __init__(self, code: str, status: int) -> None:
        super().__init__(f"{code} (HTTP {status})")
        self.code = code
        self.status = status


class NotAligned(MoraError):
    """이 곡에는 맞춰 둔 타이밍이 없다.

    곡을 못 찾았을 때와 가사가 달라 붙이지 못했을 때가 모두 여기로 온다 — 부르는 쪽에서는
    둘 다 "쓸 수 있는 타이밍이 없다"로 같기 때문이다. 어느 쪽인지는 code 로 갈린다.
    """


@dataclass(frozen=True, slots=True)
class Word:
    """한 낱말과 그것이 불린 구간."""

    text: str
    start_ms: int
    end_ms: int
    #: 들어서 잰 것이 아니라 앞뒤 사이를 나눠 짐작한 자리.
    interpolated: bool
    #: 제출한 가사에서의 코드포인트 오프셋.
    start: int
    end: int
    speaker: int | None = None

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


@dataclass(frozen=True, slots=True)
class Line:
    """한 줄과 그것이 불린 구간."""

    text: str
    start_ms: int
    end_ms: int
    words: tuple[Word, ...]
    start: int
    end: int
    speaker: int | None = None

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


@dataclass(frozen=True, slots=True)
class Speaker:
    """한 사람이 부른 구간."""

    speaker_id: int
    start_ms: int
    end_ms: int
    confidence: float


@dataclass(frozen=True, slots=True)
class Alignment:
    """가사 전체에 시각이 붙은 결과."""

    #: word 는 낱말마다, line 은 줄까지만, none 은 붙이지 못한 것.
    tier: Tier
    #: 제출한 가사가 맞춰 둔 가사와 얼마나 같은가. 1.0 이면 글자까지 같다.
    confidence: float
    tokenizer: str
    alignment_id: int
    lines: tuple[Line, ...]
    words: tuple[Word, ...]
    speakers: tuple[Speaker, ...] = ()
    text: str = field(default="", repr=False)

    @property
    def has_word_timing(self) -> bool:
        return self.tier in ("word", "word-approx")

    @property
    def duration_ms(self) -> int:
        return self.lines[-1].end_ms if self.lines else 0

    def line_at(self, position_ms: int) -> Line | None:
        """그 순간 불리고 있는 줄. 간주에는 아무것도 없으므로 None 이 나온다."""
        return _at(self.lines, position_ms)

    def word_at(self, position_ms: int) -> Word | None:
        """그 순간 불리고 있는 낱말."""
        return _at(self.words, position_ms)

    def to_lrc(self, *, enhanced: bool = True) -> str:
        """LRC 로 적는다. enhanced 면 낱말 시각도 <mm:ss.xx> 로 함께 적는다."""
        out: list[str] = []
        for line in self.lines:
            if enhanced and line.words:
                body = "".join(f"<{_lrc_time(w.start_ms)}>{w.text}" for w in line.words)
            else:
                body = line.text
            out.append(f"[{_lrc_time(line.start_ms)}]{body}")
        return "\n".join(out) + "\n"

    def __iter__(self) -> Iterator[Line]:
        return iter(self.lines)

    def __len__(self) -> int:
        return len(self.lines)


class Mora:
    """Mora 공개 API 를 부르는 클라이언트.

    맞춰 둔 타이밍은 서버가 들고 있고, 부르는 쪽은 자기가 가진 가사를 그대로 보낸다. 줄바꿈이
    다르거나 괄호 표기가 달라도 서버가 지문으로 견주어 제 자리에 얹어 주므로, 가사를 서버의
    표기에 맞출 필요가 없다. 얼마나 맞았는지는 confidence 로 돌아온다.
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        user_agent: str = "mora-lyrics-python/0.1.0",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.user_agent = user_agent

    def align(
        self,
        text: str,
        *,
        isrc: str | None = None,
        mbid: str | None = None,
        artist: str | None = None,
        title: str | None = None,
        duration_ms: int | None = None,
        language: str | None = None,
    ) -> Alignment:
        """가사에 시각을 붙여 돌려준다.

        곡은 ISRC, MusicBrainz id, 또는 (artist, title, duration_ms) 셋 중 하나로 가리킨다.
        길이로도 견주므로 artist·title 만으로는 부족하다 — 같은 이름의 다른 녹음이 있다.
        """
        body = _identify(isrc, mbid, artist, title, duration_ms)
        body["text"] = text
        if language is not None:
            body["language"] = language
        payload = self._post("/v1/align", body)
        result = _parse(payload, text)
        if result.tier == "none":
            raise NotAligned("NO_ALIGNMENT", 200)
        return result

    def align_as(
        self,
        text: str,
        fmt: Format,
        *,
        isrc: str | None = None,
        mbid: str | None = None,
        artist: str | None = None,
        title: str | None = None,
        duration_ms: int | None = None,
        language: str | None = None,
    ) -> str:
        """서버가 직접 적어 주는 형식으로 받는다 — lrc-a2, ttml, webvtt, lyricsfile."""
        body = _identify(isrc, mbid, artist, title, duration_ms)
        body["text"] = text
        if language is not None:
            body["language"] = language
        return self._post(f"/v1/align?format={fmt}", body, raw=True)

    def health(self) -> bool:
        try:
            self._request("GET", "/health", None)
        except MoraError:
            return False
        return True

    # ── 안쪽 ──────────────────────────────────────────────────────────────

    def _post(self, path: str, body: dict[str, Any], *, raw: bool = False) -> Any:
        text = self._request("POST", path, json.dumps(body, ensure_ascii=False).encode("utf-8"))
        return text if raw else json.loads(text)

    def _request(self, method: str, path: str, data: bytes | None) -> str:
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers={"User-Agent": self.user_agent, **({"Content-Type": "application/json"} if data else {})},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            raw = error.read().decode("utf-8", "replace")
            code = "UNKNOWN"
            try:
                code = str(json.loads(raw).get("error", code))
            except Exception:
                pass
            # 곡을 못 찾은 것과 서버가 고장난 것은 부르는 쪽에서 다르게 다뤄야 한다.
            failure = NotAligned if error.code == 404 else MoraError
            raise failure(code, error.code) from None
        except urllib.error.URLError as error:
            raise MoraError(f"UNREACHABLE: {error.reason}", 0) from None


def _identify(
    isrc: str | None, mbid: str | None, artist: str | None, title: str | None, duration_ms: int | None
) -> dict[str, Any]:
    if isrc:
        return {"isrc": isrc}
    if mbid:
        return {"mbid": mbid}
    if artist and title and duration_ms is not None:
        return {"artist": artist, "title": title, "duration_ms": int(duration_ms)}
    raise ValueError("곡을 가리키려면 isrc, mbid, 또는 artist·title·duration_ms 가 필요하다")


def _parse(payload: dict[str, Any], text: str) -> Alignment:
    # 오프셋은 코드포인트 단위다. 파이썬 문자열도 코드포인트로 세므로 그대로 잘라도 맞는다.
    speaker_of: dict[int, int] = {}
    for index, speaker_id, _confidence in payload.get("word_speakers") or []:
        speaker_of[int(index)] = int(speaker_id)

    words: list[Word] = []
    for index, span in enumerate(payload.get("spans") or []):
        start, end, start_ms, end_ms = span[0], span[1], span[2], span[3]
        interpolated = bool(span[4]) if len(span) > 4 else False
        words.append(
            Word(
                text=text[start:end],
                start_ms=int(start_ms),
                end_ms=int(end_ms),
                interpolated=interpolated,
                start=int(start),
                end=int(end),
                speaker=speaker_of.get(index),
            )
        )

    line_speaker: dict[int, int] = {}
    for index, speaker_id, _confidence in payload.get("line_speakers") or []:
        line_speaker[int(index)] = int(speaker_id)

    lines: list[Line] = []
    for index, (start, end, start_ms, end_ms) in enumerate(payload.get("lines") or []):
        # 줄에 속한 낱말은 오프셋으로 가른다. 서버가 줄 번호를 따로 주지 않기 때문이다.
        held = tuple(w for w in words if w.start >= start and w.end <= end)
        lines.append(
            Line(
                text=text[start:end],
                start_ms=int(start_ms),
                end_ms=int(end_ms),
                words=held,
                start=int(start),
                end=int(end),
                speaker=line_speaker.get(index),
            )
        )

    speakers = tuple(
        Speaker(int(a), int(b), int(c), float(d)) for a, b, c, d in (payload.get("speaker_turns") or [])
    )
    return Alignment(
        tier=payload.get("tier", "none"),
        confidence=float(payload.get("confidence", 0.0)),
        tokenizer=str(payload.get("tokenizer", "")),
        alignment_id=int(payload.get("alignment_id", 0)),
        lines=tuple(lines),
        words=tuple(words),
        speakers=speakers,
        text=text,
    )


def _at(items: Sequence[Any], position_ms: int) -> Any | None:
    # 시작 시각은 오름차순이므로 이분 탐색으로 후보를 하나로 좁힌 뒤 끝만 확인한다.
    starts = [item.start_ms for item in items]
    index = bisect_right(starts, position_ms) - 1
    if index < 0:
        return None
    found = items[index]
    return found if position_ms < found.end_ms else None


def _lrc_time(milliseconds: int) -> str:
    total = max(0, milliseconds)
    minutes, remainder = divmod(total, 60_000)
    seconds, hundredths = divmod(remainder, 1000)
    return f"{minutes:02d}:{seconds:02d}.{hundredths // 10:02d}"
