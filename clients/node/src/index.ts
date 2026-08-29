/**
 * 가사와 곡을 주면 낱말마다 언제 불렸는지 돌려준다.
 *
 *   import { Mora } from "mora-lyrics";
 *
 *   const mora = new Mora();
 *   const timing = await mora.align(lyrics, { isrc: "USA2P2607175" });
 *   for (const line of timing.lines) console.log(line.startMs, line.text);
 *
 * 타이밍은 Mora 가 이미 맞춰 둔 것을 가져온다. 이 라이브러리가 오디오를 듣지는 않는다.
 */

export const DEFAULT_BASE_URL = "https://mora.junx.dev";

export type Tier = "word" | "word-approx" | "line" | "none";
export type Format = "spans" | "lrc-a2" | "lyricsfile" | "ttml" | "webvtt";

/** 곡을 가리키는 법. 셋 중 하나면 된다. */
export type Recording =
  | { isrc: string }
  | { mbid: string }
  | { artist: string; title: string; durationMs: number };

export interface Options {
  language?: string;
  signal?: AbortSignal;
}

export interface Word {
  text: string;
  startMs: number;
  endMs: number;
  /** 들어서 잰 것이 아니라 앞뒤 사이를 나눠 짐작한 자리. */
  interpolated: boolean;
  /** 제출한 가사에서의 코드포인트 오프셋. 자를 때는 Alignment.slice 를 쓴다. */
  start: number;
  end: number;
  speaker?: number;
}

export interface Line {
  text: string;
  startMs: number;
  endMs: number;
  words: Word[];
  start: number;
  end: number;
  speaker?: number;
}

export interface Speaker {
  speakerId: number;
  startMs: number;
  endMs: number;
  confidence: number;
}

export class MoraError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`${code} (HTTP ${status})`);
    this.name = "MoraError";
  }
}

/**
 * 이 곡에는 쓸 수 있는 타이밍이 없다.
 *
 * 곡을 못 찾았을 때와 가사가 달라 붙이지 못했을 때가 모두 여기로 온다 — 부르는 쪽에서는
 * 둘 다 같은 뜻이기 때문이다. 어느 쪽인지는 code 로 갈린다.
 */
export class NotAligned extends MoraError {
  constructor(code: string, status: number) {
    super(code, status);
    this.name = "NotAligned";
  }
}

export class Alignment {
  constructor(
    /** word 는 낱말마다, line 은 줄까지만. */
    readonly tier: Tier,
    /** 제출한 가사가 맞춰 둔 가사와 얼마나 같은가. 1 이면 글자까지 같다. */
    readonly confidence: number,
    readonly tokenizer: string,
    readonly alignmentId: number,
    readonly lines: Line[],
    readonly words: Word[],
    readonly speakers: Speaker[],
    readonly text: string,
  ) {}

  get hasWordTiming(): boolean {
    return this.tier === "word" || this.tier === "word-approx";
  }

  get durationMs(): number {
    return this.lines.length > 0 ? this.lines[this.lines.length - 1]!.endMs : 0;
  }

  /** 그 순간 불리고 있는 줄. 간주에는 아무것도 없으므로 undefined 가 나온다. */
  lineAt(positionMs: number): Line | undefined {
    return at(this.lines, positionMs);
  }

  /** 그 순간 불리고 있는 낱말. */
  wordAt(positionMs: number): Word | undefined {
    return at(this.words, positionMs);
  }

  /** LRC 로 적는다. enhanced 면 낱말 시각도 함께 적는다. */
  toLrc(enhanced = true): string {
    return (
      this.lines
        .map((line) => {
          const body =
            enhanced && line.words.length > 0
              ? line.words.map((word) => `<${lrcTime(word.startMs)}>${word.text}`).join("")
              : line.text;
          return `[${lrcTime(line.startMs)}]${body}`;
        })
        .join("\n") + "\n"
    );
  }

  [Symbol.iterator](): Iterator<Line> {
    return this.lines[Symbol.iterator]();
  }
}

export class Mora {
  readonly baseUrl: string;
  private readonly userAgent: string;

  constructor(baseUrl: string = DEFAULT_BASE_URL, options: { userAgent?: string } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/u, "");
    this.userAgent = options.userAgent ?? "mora-lyrics-node/0.1.0";
  }

  /**
   * 가사에 시각을 붙여 돌려준다.
   *
   * 줄바꿈이 다르거나 괄호 표기가 달라도 서버가 지문으로 견주어 제 자리에 얹어 주므로,
   * 가사를 서버의 표기에 맞출 필요가 없다. 얼마나 맞았는지는 confidence 로 돌아온다.
   */
  async align(text: string, recording: Recording, options: Options = {}): Promise<Alignment> {
    const payload = await this.post("/v1/align", { ...identify(recording), text, ...language(options) }, options.signal);
    const result = parse(payload as Payload, text);
    if (result.tier === "none") throw new NotAligned("NO_ALIGNMENT", 200);
    return result;
  }

  /** 서버가 직접 적어 주는 형식으로 받는다 — lrc-a2, ttml, webvtt, lyricsfile. */
  async alignAs(text: string, format: Format, recording: Recording, options: Options = {}): Promise<string> {
    return (await this.post(
      `/v1/align?format=${encodeURIComponent(format)}`,
      { ...identify(recording), text, ...language(options) },
      options.signal,
      true,
    )) as string;
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, { headers: { "User-Agent": this.userAgent } });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async post(path: string, body: unknown, signal?: AbortSignal, raw = false): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": this.userAgent },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new MoraError(`UNREACHABLE: ${error instanceof Error ? error.message : String(error)}`, 0);
    }
    if (!response.ok) {
      const code = await response
        .clone()
        .json()
        .then((value) => String((value as { error?: unknown }).error ?? "UNKNOWN"))
        .catch(() => "UNKNOWN");
      // 곡을 못 찾은 것과 서버가 고장난 것은 부르는 쪽에서 다르게 다뤄야 한다.
      throw response.status === 404 ? new NotAligned(code, 404) : new MoraError(code, response.status);
    }
    return raw ? await response.text() : await response.json();
  }
}

// ── 안쪽 ────────────────────────────────────────────────────────────────────

interface Payload {
  tier?: Tier;
  confidence?: number;
  tokenizer?: string;
  alignment_id?: number;
  lines?: Array<[number, number, number, number]>;
  spans?: Array<[number, number, number, number, 0 | 1]>;
  speaker_turns?: Array<[number, number, number, number]>;
  word_speakers?: Array<[number, number, number]>;
  line_speakers?: Array<[number, number, number]>;
}

/**
 * 코드포인트 자리를 자바스크립트 문자열의 자리로 옮기는 표.
 *
 * 서버는 오프셋을 코드포인트로 센다. 자바스크립트 문자열은 UTF-16 코드유닛으로 세므로,
 * 보조평면 글자 — 이모지, 일부 한자 — 가 하나라도 섞이면 그 뒤의 모든 자리가 밀린다.
 * 가사에 이모지는 드물지 않고, 어긋난 결과는 조용히 틀린 낱말을 가리킨다.
 */
function codepointIndex(text: string): number[] {
  const map: number[] = [];
  for (let unit = 0; unit < text.length; ) {
    map.push(unit);
    unit += (text.codePointAt(unit) ?? 0) > 0xffff ? 2 : 1;
  }
  map.push(text.length);
  return map;
}

function identify(recording: Recording): Record<string, unknown> {
  if ("isrc" in recording && recording.isrc) return { isrc: recording.isrc };
  if ("mbid" in recording && recording.mbid) return { mbid: recording.mbid };
  // 길이로도 견준다 — 같은 이름의 다른 녹음이 있기 때문이다. 타입이 막아 주지만 자바스크립트
  // 에서 부르는 쪽은 그 보호를 받지 못한다. 빠진 채로 보내면 서버까지 갔다가 400 으로 돌아온다.
  const named = recording as { artist?: string; title?: string; durationMs?: number };
  if (named.artist && named.title && Number.isFinite(named.durationMs)) {
    return { artist: named.artist, title: named.title, duration_ms: Math.round(named.durationMs as number) };
  }
  throw new TypeError("곡을 가리키려면 isrc, mbid, 또는 artist·title·durationMs 가 필요하다");
}

function language(options: Options): Record<string, string> {
  return options.language === undefined ? {} : { language: options.language };
}

function parse(payload: Payload, text: string): Alignment {
  const index = codepointIndex(text);
  const cut = (start: number, end: number): string =>
    text.slice(index[Math.min(start, index.length - 1)]!, index[Math.min(end, index.length - 1)]!);

  const wordSpeaker = new Map<number, number>();
  for (const [position, speakerId] of payload.word_speakers ?? []) wordSpeaker.set(position, speakerId);

  const words: Word[] = (payload.spans ?? []).map(([start, end, startMs, endMs, interpolated], position) => ({
    text: cut(start, end),
    startMs,
    endMs,
    interpolated: interpolated === 1,
    start,
    end,
    speaker: wordSpeaker.get(position),
  }));

  const lineSpeaker = new Map<number, number>();
  for (const [position, speakerId] of payload.line_speakers ?? []) lineSpeaker.set(position, speakerId);

  const lines: Line[] = (payload.lines ?? []).map(([start, end, startMs, endMs], position) => ({
    text: cut(start, end),
    startMs,
    endMs,
    // 줄에 속한 낱말은 오프셋으로 가른다. 서버가 줄 번호를 따로 주지 않기 때문이다.
    words: words.filter((word) => word.start >= start && word.end <= end),
    start,
    end,
    speaker: lineSpeaker.get(position),
  }));

  const speakers: Speaker[] = (payload.speaker_turns ?? []).map(([speakerId, startMs, endMs, confidence]) => ({
    speakerId,
    startMs,
    endMs,
    confidence,
  }));

  return new Alignment(
    payload.tier ?? "none",
    payload.confidence ?? 0,
    payload.tokenizer ?? "",
    payload.alignment_id ?? 0,
    lines,
    words,
    speakers,
    text,
  );
}

function at<T extends { startMs: number; endMs: number }>(items: T[], positionMs: number): T | undefined {
  // 시작 시각은 오름차순이므로 이분 탐색으로 후보를 하나로 좁힌 뒤 끝만 확인한다.
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (items[middle]!.startMs <= positionMs) low = middle + 1;
    else high = middle;
  }
  const found = items[low - 1];
  return found !== undefined && positionMs < found.endMs ? found : undefined;
}

function lrcTime(milliseconds: number): string {
  const total = Math.max(0, milliseconds);
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const hundredths = Math.floor((total % 1000) / 10);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
}
