/**
 * Which timings the pipeline measured and which it filled in.
 *
 * The aligner scores every word it places. A word it could not find at all is given a spot
 * between its neighbours and a score of 0.3 or below — that is the pipeline saying, in its own
 * words, "I put this here, I did not hear it there".
 *
 * This used to be guessed from length instead: a word sitting on the shortest time a human could
 * sing it was called a rescue. That marked words that were simply short. "the" is one syllable
 * and often really is 120ms, so correct timings came back flagged, which is worse than not
 * flagging at all — it teaches the reviewer to ignore the mark.
 */
export const GUESSED_AT_OR_BELOW = 0.35;

/** True when the pipeline placed this word rather than measuring it. */
export function wasGuessed(score: number | undefined): boolean {
  return score !== undefined && score > 0 && score <= GUESSED_AT_OR_BELOW;
}

/** 대강의 음절 수. 자리 없는 낱말을 넣을 때 얼마나 길게 잡을지 정하는 데만 쓴다. */
export function syllables(word: string): number {
  let count = 0;
  let inVowelRun = false;
  for (const character of word) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0xac00 && code <= 0xd7a3) || (code >= 0x3040 && code <= 0x30ff) || (code >= 0x4e00 && code <= 0x9fff)) {
      count += 1;
      inVowelRun = false;
    } else if (/\p{Nd}/u.test(character)) {
      count += 1;
      inVowelRun = false;
    } else if (/\p{L}/u.test(character)) {
      const vowel = "aeiouy".includes(character.toLowerCase());
      if (vowel && !inVowelRun) count += 1;
      inVowelRun = vowel;
    } else {
      inVowelRun = false;
    }
  }
  return Math.max(1, count);
}

/** 이 낱말이 정직하게 가질 수 있는 가장 짧은 시간 — 파이프라인과 같은 값을 낸다. */
export function floorMs(word: string): number {
  return Math.max(120, 100 * syllables(word));
}

/**
 * A line lasts as long as its own words last.
 *
 * The editor edits words; the line spans it was handed came from the pipeline and go stale the
 * moment a word moves. Saving them unchanged writes a line that no longer covers its own words.
 */
export function linesOverWords(
  wordSpans: Array<[number, number, number]>,
  lines: Array<{ index: number; token_indices: number[] }>,
  fallback: Array<[number, number]>,
): Array<[number, number]> {
  const byToken = new Map(wordSpans.map((span) => [span[0], span]));
  return lines.map((line, position) => {
    const held = line.token_indices
      .map((token) => byToken.get(token))
      .filter((span): span is [number, number, number] => span !== undefined);
    if (held.length === 0) return fallback[position] ?? [0, 1];
    return [Math.min(...held.map((span) => span[1])), Math.max(...held.map((span) => span[2]))];
  });
}
