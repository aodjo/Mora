import { activeLines } from "../tokenization/tokenizer.js";
import type {
  AlignmentResult,
  Fingerprint,
  FingerprintAlignmentResult,
  IndexedTimeSpan,
  MatchResult,
  OffsetTimeSpan,
  ProjectedIndexedTimeSpan,
  ProjectedOffsetTimeSpan,
  StoredAlignment,
  TimeSpan,
  Tokenization,
} from "../shared/types.js";

function clampTime(value: number, start: number, end: number): number {
  return Math.max(start, Math.min(end, Math.round(value)));
}

function distribute(tokenIndices: number[], lengths: number[], startMs: number, endMs: number): IndexedTimeSpan[] {
  if (tokenIndices.length === 0) return [];
  const total = lengths.reduce((sum, length) => sum + Math.max(1, length), 0);
  let cursor = startMs;
  return tokenIndices.map((tokenIndex, index) => {
    const length = Math.max(1, lengths[index] ?? 1);
    const next = index === tokenIndices.length - 1 ? endMs : clampTime(cursor + ((endMs - startMs) * length) / total, cursor, endMs);
    const span: IndexedTimeSpan = [tokenIndex, cursor, next];
    cursor = next;
    return span;
  });
}

function interpolateLine(
  targetIndices: number[],
  targetLengths: number[],
  known: Map<number, TimeSpan>,
  lineSpan: TimeSpan,
): ProjectedIndexedTimeSpan[] {
  const output: ProjectedIndexedTimeSpan[] = [];
  let position = 0;
  let cursor = lineSpan[0];

  while (position < targetIndices.length) {
    const tokenIndex = targetIndices[position];
    if (tokenIndex === undefined) break;
    const currentKnown = known.get(tokenIndex);
    if (currentKnown !== undefined) {
      output.push([tokenIndex, currentKnown[0], currentKnown[1], 0]);
      cursor = currentKnown[1];
      position += 1;
      continue;
    }

    let nextKnownPosition = position + 1;
    while (nextKnownPosition < targetIndices.length && !known.has(targetIndices[nextKnownPosition] ?? -1)) {
      nextKnownPosition += 1;
    }
    const gapIndices = targetIndices.slice(position, nextKnownPosition);
    const gapLengths = targetLengths.slice(position, nextKnownPosition);
    const nextIndex = targetIndices[nextKnownPosition];
    const nextSpan = nextIndex === undefined ? undefined : known.get(nextIndex);

    if (nextSpan !== undefined && nextSpan[0] <= cursor) {
      const groupIndices = [...gapIndices, nextIndex as number];
      const groupLengths = [...gapLengths, targetLengths[nextKnownPosition] ?? 1];
      const divided = distribute(groupIndices, groupLengths, cursor, Math.max(cursor, nextSpan[1]));
      output.push(...divided.map(([index, start, end]) => [index, start, end, 1] as ProjectedIndexedTimeSpan));
      cursor = divided.at(-1)?.[2] ?? cursor;
      position = nextKnownPosition + 1;
      continue;
    }

    const gapEnd = nextSpan?.[0] ?? lineSpan[1];
    if (gapEnd > cursor) {
      output.push(
        ...distribute(gapIndices, gapLengths, cursor, gapEnd).map(
          ([index, start, end]) => [index, start, end, 1] as ProjectedIndexedTimeSpan,
        ),
      );
      cursor = gapEnd;
    } else {
      const previous = output.pop();
      if (previous !== undefined) {
        const previousPosition = position - 1;
        const divided = distribute(
          [previous[0], ...gapIndices],
          [targetLengths[previousPosition] ?? 1, ...gapLengths],
          previous[1],
          Math.max(previous[2], lineSpan[1]),
        );
        output.push(
          ...divided.map(
            ([token, start, end], dividedIndex) => [token, start, end, dividedIndex === 0 ? previous[3] : 1] as ProjectedIndexedTimeSpan,
          ),
        );
        cursor = divided.at(-1)?.[2] ?? cursor;
      }
    }
    position = nextKnownPosition;
  }
  return output;
}

function mappedLineSpans(alignment: StoredAlignment, match: MatchResult): Map<number, TimeSpan> {
  const result = new Map<number, TimeSpan>();
  for (const [sourceLine, targetLine] of match.sourceToTargetLines) {
    const span = alignment.lineSpans[sourceLine];
    if (span !== undefined) result.set(targetLine, span);
  }
  return result;
}

function mappedWordSpans(alignment: StoredAlignment, match: MatchResult): Map<number, TimeSpan> {
  const result = new Map<number, TimeSpan>();
  for (const [sourceToken, startMs, endMs] of alignment.wordSpans) {
    const targetToken = match.sourceToTargetTokens.get(sourceToken);
    if (targetToken !== undefined) result.set(targetToken, [startMs, endMs]);
  }
  return result;
}

export function projectFingerprintAlignment(
  alignment: StoredAlignment,
  target: Fingerprint,
  match: MatchResult,
): FingerprintAlignmentResult {
  const linesByTarget = mappedLineSpans(alignment, match);
  const knownWords = mappedWordSpans(alignment, match);
  const spans: ProjectedIndexedTimeSpan[] = [];
  const lines: Array<[number, number, number]> = [];
  let targetTokenOffset = 0;

  for (let lineIndex = 0; lineIndex < target.lens.length; lineIndex += 1) {
    const lengths = target.lens[lineIndex] ?? [];
    const tokenIndices = lengths.map((_, index) => targetTokenOffset + index);
    const lineSpan = linesByTarget.get(lineIndex);
    if (lineSpan !== undefined) {
      lines.push([lineIndex, lineSpan[0], lineSpan[1]]);
      if (match.tier === "word-approx") {
        spans.push(...interpolateLine(tokenIndices, lengths, knownWords, lineSpan));
      } else if (match.tier === "word") {
        for (const tokenIndex of tokenIndices) {
          const time = knownWords.get(tokenIndex);
          if (time !== undefined) spans.push([tokenIndex, time[0], time[1], 0]);
        }
      }
    }
    targetTokenOffset += lengths.length;
  }

  return {
    tier: match.tier,
    confidence: match.confidence,
    tokenizer: alignment.tokenizer === "unilab-v2" ? "unilab-v2" : "unilab-v1",
    alignment_id: alignment.id,
    lines,
    spans: match.tier === "line" || match.tier === "none" ? [] : spans.sort((left, right) => left[0] - right[0]),
    speaker_turns: match.tier === "none" ? [] : (alignment.speakerTurns ?? []),
    word_speakers:
      match.tier === "none"
        ? []
        : (alignment.wordSpeakers ?? []).flatMap(([sourceIndex, speaker, confidence]) => {
            const targetIndex = match.sourceToTargetTokens.get(sourceIndex);
            return targetIndex === undefined ? [] : [[targetIndex, speaker, confidence]];
          }),
    line_speakers:
      match.tier === "none"
        ? []
        : (alignment.lineSpeakers ?? []).flatMap(([sourceIndex, speaker, confidence]) => {
            const targetIndex = match.sourceToTargetLines.get(sourceIndex);
            return targetIndex === undefined ? [] : [[targetIndex, speaker, confidence]];
          }),
  };
}

export function projectTextAlignment(
  alignment: StoredAlignment,
  tokenization: Tokenization,
  target: Fingerprint,
  match: MatchResult,
): AlignmentResult {
  const indexed = projectFingerprintAlignment(alignment, target, match);
  const targetLines = activeLines(tokenization);
  const lines: OffsetTimeSpan[] = indexed.lines.flatMap(([lineIndex, startMs, endMs]) => {
    const line = targetLines[lineIndex];
    return line === undefined ? [] : [[line.start, line.end, startMs, endMs] satisfies OffsetTimeSpan];
  });
  const spans: ProjectedOffsetTimeSpan[] = indexed.spans.flatMap(([tokenIndex, startMs, endMs, interpolated]) => {
    const token = tokenization.tokens[tokenIndex];
    return token === undefined ? [] : [[token.start, token.end, startMs, endMs, interpolated] satisfies ProjectedOffsetTimeSpan];
  });

  return {
    tier: indexed.tier,
    confidence: indexed.confidence,
    tokenizer: indexed.tokenizer,
    offset_unit: "codepoint",
    alignment_id: alignment.id,
    lines,
    spans,
    speaker_turns: indexed.speaker_turns,
    word_speakers: indexed.word_speakers,
    line_speakers: indexed.line_speakers,
  };
}
