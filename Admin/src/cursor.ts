/** 커서가 어느 낱말 위에 있는지 — 화면과 시험이 함께 쓰는 규칙. */
export type WordSpan = [number, number, number];

/**
 * The word the cursor sits on: the last one to have started that is still running.
 *
 * Spans overlap on purpose — a bracketed aside is sung over the line beside it, so it holds the
 * same seconds. Taking the first match in token order let the aside keep the cursor for the whole
 * overlap and then hand it to the middle of the next line, which reads on screen as the lyric
 * filling to the end and jumping back to the start. A second voice is never given the cursor;
 * among the rest, the one that started most recently is the one being sung.
 */
export function cursorSpan(spans: WordSpan[], atMs: number, isSecondVoice: (token: number) => boolean): WordSpan | undefined {
  let best: WordSpan | undefined;
  for (const span of spans) {
    if (atMs < span[1] || atMs >= span[2] || isSecondVoice(span[0])) continue;
    if (best === undefined || span[1] >= best[1]) best = span;
  }
  return best;
}

export function isAside(text: string): boolean {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return false;
  let depth = 0;
  return words.every((word) => {
    let inside = depth > 0;
    for (const character of word) {
      if ("([{（［".includes(character)) {
        depth += 1;
        inside = true;
      } else if (")]}）］".includes(character) && depth > 0) depth -= 1;
    }
    return inside && /[\p{L}\p{N}]/u.test(word);
  });
}
