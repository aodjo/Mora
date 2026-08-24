/**
 * Which timings are a measurement and which are the floor the pipeline fell back to.
 *
 * When the forced aligner collapses a stretch of words, the pipeline gives each of them the
 * shortest time a human could have sung it and no more — a hundred milliseconds a syllable.
 * A word left sitting exactly on that floor was not measured; it was rescued. On the measured
 * songs that is 2% of words in one and 8% in another, and they are almost all one syllable:
 * 날, 넌, 내, 너. They flash past in seven frames, which is what "간헐적으로 놓친다" looks like.
 *
 * The score the aligner reports does not find them — 날 came back at 106ms with a score of
 * 0.51, which reads as measured. The floor does find them, and it can be worked out here from
 * the word itself, so nothing has to be stored.
 */
export const MIN_WORD_MS = 120;
export const MIN_SYLLABLE_MS = 100;

/** Roughly how many syllables a word has; used only to work out how long it ought to run. */
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

/** The shortest this word could honestly have taken. */
export function floorMs(word: string): number {
  return Math.max(MIN_WORD_MS, MIN_SYLLABLE_MS * syllables(word));
}

/** True when the word was given the floor rather than a time taken from the audio. */
export function onlyTheFloor(word: string, startMs: number, endMs: number): boolean {
  return endMs - startMs <= floorMs(word) + 1;
}
