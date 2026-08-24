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

/**
 * The stretch a word with no time belongs in: between the words of its line that do have one.
 *
 * A word is not free to be anywhere. The line is sung in the order it is written, so a word with
 * no time sits in exactly one place — the hole its neighbours leave. Returns null when the line
 * has no placed neighbour on either side and there is therefore nothing to reason from.
 */
export function gapFor(
  spans: WordSpan[],
  token: number,
  lineOf: (token: number) => number | undefined,
): { from: number; to: number; row: number } | null {
  const found = spans.findIndex((span) => span[0] > token);
  const row = found === -1 ? spans.length : found;
  const line = lineOf(token);
  const before = row > 0 && lineOf((spans[row - 1] as WordSpan)[0]) === line ? (spans[row - 1] as WordSpan)[2] : null;
  const after = row < spans.length && lineOf((spans[row] as WordSpan)[0]) === line ? (spans[row] as WordSpan)[1] : null;
  if (before === null && after === null) return null;
  return { from: before ?? Math.max(0, (after as number) - 600), to: after ?? (before as number) + 600, row };
}

/**
 * Drop a word with no time into the hole it belongs in, filling it.
 *
 * The pipeline does not always place every word — a line the aligner found nothing in falls back
 * to a guess, and a word can come out of it with no span at all. Those words were invisible: the
 * timeline had nowhere to draw them and the table had no row to type into, so the only thing a
 * reviewer could do was leave them unsaid.
 *
 * It takes the whole hole rather than a fixed length, because the hole is what is actually known
 * about it: the word before ends here, the word after begins there, and it was sung in between.
 * Inserted in token order, because everything downstream reads the list that way — the cursor,
 * the ripple, and the draft check that the same words are still there.
 */
export function placeWord(
  spans: WordSpan[],
  token: number,
  atMs: number,
  floorMs: number,
  lineOf: (token: number) => number | undefined = () => undefined,
): { spans: WordSpan[]; row: number; filled: boolean } {
  const gap = gapFor(spans, token, lineOf);
  const found = spans.findIndex((span) => span[0] > token);
  const row = gap?.row ?? (found === -1 ? spans.length : found);
  const width = Math.max(MIN_SPAN_MS, Math.round(floorMs * 2));
  let placed: WordSpan;
  let filled = false;
  if (gap !== null && gap.to - gap.from >= MIN_SPAN_MS) {
    // 빈틈이 아는 전부다. 그 안을 채운다.
    placed = [token, Math.round(gap.from), Math.round(gap.to)];
    filled = true;
  } else if (gap !== null) {
    // 이웃이 맞닿아 있어 들어갈 자리가 없다. 시작만 맞추고 이웃이 먹히게 둔다.
    placed = [token, Math.round(gap.from), Math.round(gap.from) + width];
  } else {
    const from = Math.max(0, Math.round(atMs));
    placed = [token, from, from + width];
  }
  return { spans: [...spans.slice(0, row), placed, ...spans.slice(row)], row, filled };
}
