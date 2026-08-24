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
 * Give a word that has no time one, at the moment the reviewer says it is sung.
 *
 * The pipeline does not always place every word — a line the aligner found nothing in falls back
 * to a guess, and a word can come out of it with no span at all. Those words were invisible: the
 * timeline had nowhere to draw them and the table had no row to type into, so the only thing a
 * reviewer could do was leave them unsaid.
 *
 * It is inserted in token order, because everything downstream reads the list that way — the
 * cursor, the ripple, and the draft check that the same words are still there. The length is the
 * shortest the word could honestly be, doubled: long enough to see and grab, short enough that it
 * is obviously a starting point rather than a measurement.
 */
export function placeWord(
  spans: WordSpan[],
  token: number,
  atMs: number,
  floorMs: number,
  lineOf: (token: number) => number | undefined = () => undefined,
): { spans: WordSpan[]; row: number; clamped: boolean } {
  const found = spans.findIndex((span) => span[0] > token);
  const at = found === -1 ? spans.length : found;
  const line = lineOf(token);
  // 제 줄 안에서 앞뒤 낱말이 이미 자리를 잡고 있으면, 그 사이가 이 낱말이 있을 수 있는
  // 전부다. 재생 위치가 그 밖이면 그것은 이 낱말의 순간이 아니다.
  const before = at > 0 && lineOf((spans[at - 1] as WordSpan)[0]) === line ? (spans[at - 1] as WordSpan)[2] : 0;
  const after = at < spans.length && lineOf((spans[at] as WordSpan)[0]) === line ? (spans[at] as WordSpan)[1] : Number.POSITIVE_INFINITY;
  const width = Math.max(MIN_SPAN_MS, Math.round(floorMs * 2));
  const wanted = Math.max(0, Math.round(atMs));
  const room = Math.max(before, Math.min(wanted, after - MIN_SPAN_MS));
  const start = Number.isFinite(room) ? room : wanted;
  const placed: WordSpan = [
    token,
    start,
    Math.min(start + width, Number.isFinite(after) ? Math.max(start + MIN_SPAN_MS, after) : start + width),
  ];
  return { spans: [...spans.slice(0, at), placed, ...spans.slice(at)], row: at, clamped: start !== wanted };
}
