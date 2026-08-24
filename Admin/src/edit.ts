import type { WordSpan } from "./cursor.js";

/** 사람이 낼 수 있는 가장 짧은 소리. 이웃을 먹더라도 이보다 얇게 남기지는 않는다. */
export const MIN_SPAN_MS = 40;

/**
 * Let a dragged word eat into its neighbours instead of lying on top of them.
 *
 * Two words of one line cannot be sung at once, so a word pushed over the one beside it is not
 * describing an overlap — it is saying that word started later, or ended earlier, than the
 * aligner thought. Leaving both where they are gives the line two answers for the same instant
 * and the cursor picks whichever comes first in token order.
 *
 * So the neighbour gives way, and if it is squeezed to nothing it gives way in turn — the push
 * carries down the line the way a ripple trim does. It stops at the line's edge: a bracketed
 * aside really is a second voice sung over the line beside it, and that overlap is the song.
 */
export function pushNeighbours(spans: WordSpan[], row: number, lineOf: (token: number) => number | undefined): WordSpan[] {
  const out = spans.map((span) => [...span] as WordSpan);
  const moved = out[row];
  if (moved === undefined) return out;
  const line = lineOf(moved[0]);

  for (let index = row - 1; index >= 0; index -= 1) {
    const span = out[index];
    const after = out[index + 1];
    if (span === undefined || after === undefined || lineOf(span[0]) !== line) break;
    if (span[2] <= after[1]) break;
    span[2] = after[1];
    if (span[2] - span[1] < MIN_SPAN_MS) span[1] = Math.max(0, span[2] - MIN_SPAN_MS);
  }

  for (let index = row + 1; index < out.length; index += 1) {
    const span = out[index];
    const before = out[index - 1];
    if (span === undefined || before === undefined || lineOf(span[0]) !== line) break;
    if (span[1] >= before[2]) break;
    span[1] = before[2];
    if (span[2] - span[1] < MIN_SPAN_MS) span[2] = span[1] + MIN_SPAN_MS;
  }

  return out;
}
