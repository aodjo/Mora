import { fingerprintTokenCount } from "../tokenization/fingerprint.js";
import { needlemanWunsch } from "./needleman-wunsch.js";
import type { Fingerprint, MatchResult, Tier, TokenType } from "../shared/types.js";

interface TokenShape {
  length: number;
  type: TokenType;
}

function lineScore(leftCount: number, rightCount: number): number {
  const difference = Math.abs(leftCount - rightCount);
  if (difference === 0) return 2;
  if (difference === 1) return 0.8;
  if (difference <= 3) return -0.2;
  return -1.5;
}

function tokenScore(left: TokenShape, right: TokenShape): number {
  const difference = Math.abs(left.length - right.length);
  const lengthScore = difference === 0 ? 1.5 : difference === 1 ? 0.5 : difference === 2 ? -0.3 : -1;
  return lengthScore + (left.type === right.type ? 0.5 : -0.5);
}

export function tierForConfidence(confidence: number): Tier {
  if (confidence >= 0.9) return "word";
  if (confidence >= 0.6) return "word-approx";
  if (confidence >= 0.3) return "line";
  return "none";
}

function matchFlat(source: Fingerprint, target: Fingerprint): MatchResult {
  const sourceTokens = source.lens.flatMap((line, lineIndex) =>
    line.map((length, index) => ({ length, type: source.types[lineIndex]?.[index] ?? 3 })),
  );
  const targetTokens = target.lens.flatMap((line, lineIndex) =>
    line.map((length, index) => ({ length, type: target.types[lineIndex]?.[index] ?? 3 })),
  );
  const pairs = needlemanWunsch(sourceTokens, targetTokens, tokenScore, -1);
  const sourceToTargetTokens = new Map<number, number>();
  let exactTokens = 0;
  for (const pair of pairs) {
    sourceToTargetTokens.set(pair.left, pair.right);
    const left = sourceTokens[pair.left];
    const right = targetTokens[pair.right];
    if (left?.length === right?.length && left?.type === right?.type) exactTokens += 1;
  }
  const maxTokens = Math.max(sourceTokens.length, targetTokens.length);
  const confidence = maxTokens === 0 ? 0 : exactTokens / maxTokens;
  return {
    confidence,
    tier: tierForConfidence(confidence),
    exactTokens,
    matchedLines: confidence > 0 ? 1 : 0,
    sourceTokenCount: sourceTokens.length,
    targetTokenCount: targetTokens.length,
    sourceToTargetTokens,
    sourceToTargetLines: new Map(source.lens.map((_, index) => [index, 0])),
  };
}

function lineTokens(value: Fingerprint, line: number): TokenShape[] {
  const lengths = value.lens[line] ?? [];
  const types = value.types[line] ?? [];
  return lengths.map((length, index) => ({ length, type: types[index] ?? 3 }));
}

function lineOffsets(value: Fingerprint): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  for (const line of value.lens) {
    offsets.push(cursor);
    cursor += line.length;
  }
  return offsets;
}

export function matchFingerprints(source: Fingerprint, target: Fingerprint): MatchResult {
  if (target.lens.length === 1 && source.lens.length > 1) return matchFlat(source, target);
  const sourceLineCounts = source.lens.map((line) => line.length);
  const targetLineCounts = target.lens.map((line) => line.length);
  const linePairs = needlemanWunsch(sourceLineCounts, targetLineCounts, lineScore, -1.2);
  const sourceOffsets = lineOffsets(source);
  const targetOffsets = lineOffsets(target);
  const sourceToTargetTokens = new Map<number, number>();
  const sourceToTargetLines = new Map<number, number>();
  let exactTokens = 0;

  for (const pair of linePairs) {
    sourceToTargetLines.set(pair.left, pair.right);
    const sourceTokens = lineTokens(source, pair.left);
    const targetTokens = lineTokens(target, pair.right);
    const tokenPairs = needlemanWunsch(sourceTokens, targetTokens, tokenScore, -1);

    for (const tokenPair of tokenPairs) {
      const sourceToken = sourceTokens[tokenPair.left];
      const targetToken = targetTokens[tokenPair.right];
      const sourceOffset = sourceOffsets[pair.left];
      const targetOffset = targetOffsets[pair.right];
      if (sourceToken === undefined || targetToken === undefined || sourceOffset === undefined || targetOffset === undefined) {
        continue;
      }

      sourceToTargetTokens.set(sourceOffset + tokenPair.left, targetOffset + tokenPair.right);
      if (sourceToken.length === targetToken.length && sourceToken.type === targetToken.type) {
        exactTokens += 1;
      }
    }
  }

  const sourceTokenCount = fingerprintTokenCount(source);
  const targetTokenCount = fingerprintTokenCount(target);
  const maxTokens = Math.max(sourceTokenCount, targetTokenCount);
  const maxLines = Math.max(source.lens.length, target.lens.length);
  const tokenRatio = maxTokens === 0 ? 0 : exactTokens / maxTokens;
  const lineRatio = maxLines === 0 ? 0 : linePairs.length / maxLines;
  const confidence = tokenRatio * (0.5 + 0.5 * lineRatio);

  return {
    confidence,
    tier: tierForConfidence(confidence),
    exactTokens,
    matchedLines: linePairs.length,
    sourceTokenCount,
    targetTokenCount,
    sourceToTargetTokens,
    sourceToTargetLines,
  };
}
