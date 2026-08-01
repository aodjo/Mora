export interface SequencePair {
  left: number;
  right: number;
}

type Direction = "diagonal" | "up" | "left";

/** Global sequence alignment with deterministic diagonal-first tie breaking. */
export function needlemanWunsch<T, U>(
  left: readonly T[],
  right: readonly U[],
  score: (left: T, right: U) => number,
  gapPenalty: number,
): SequencePair[] {
  const columns = right.length + 1;
  const scores = new Float64Array((left.length + 1) * columns);
  const trace: Array<Direction | undefined> = new Array((left.length + 1) * columns);
  const at = (row: number, column: number): number => row * columns + column;

  for (let row = 1; row <= left.length; row += 1) {
    scores[at(row, 0)] = row * gapPenalty;
    trace[at(row, 0)] = "up";
  }
  for (let column = 1; column <= right.length; column += 1) {
    scores[at(0, column)] = column * gapPenalty;
    trace[at(0, column)] = "left";
  }

  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const leftValue = left[row - 1];
      const rightValue = right[column - 1];
      if (leftValue === undefined || rightValue === undefined) continue;

      const diagonal = (scores[at(row - 1, column - 1)] ?? 0) + score(leftValue, rightValue);
      const up = (scores[at(row - 1, column)] ?? 0) + gapPenalty;
      const moveLeft = (scores[at(row, column - 1)] ?? 0) + gapPenalty;
      const best = Math.max(diagonal, up, moveLeft);
      scores[at(row, column)] = best;
      trace[at(row, column)] = best === diagonal ? "diagonal" : best === up ? "up" : "left";
    }
  }

  const pairs: SequencePair[] = [];
  let row = left.length;
  let column = right.length;
  while (row > 0 || column > 0) {
    const direction = trace[at(row, column)];
    if (direction === "diagonal") {
      pairs.push({ left: row - 1, right: column - 1 });
      row -= 1;
      column -= 1;
    } else if (direction === "up") {
      row -= 1;
    } else if (direction === "left") {
      column -= 1;
    } else {
      break;
    }
  }

  return pairs.reverse();
}
