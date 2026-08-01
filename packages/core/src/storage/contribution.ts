import { ServiceError } from "../shared/errors.js";
import { fingerprintTokenCount } from "../tokenization/fingerprint.js";
import type { Contribution } from "./repository.js";

export function validateContribution(value: Contribution): void {
  if (value.tokenizer !== "unilab-v1" && value.tokenizer !== "unilab-v2") throw new ServiceError(400, "UNSUPPORTED_TOKENIZER");
  if (!/^[0-9a-f]{16}$/.test(value.textHash)) throw new ServiceError(400, "INVALID_REQUEST");
  if (value.fingerprint.lens.length !== value.lineSpans.length) {
    throw new ServiceError(400, "INVALID_REQUEST");
  }

  const tokenCount = fingerprintTokenCount(value.fingerprint);
  if (value.wordSpans.some(([index]) => index >= tokenCount)) {
    throw new ServiceError(400, "INVALID_REQUEST");
  }
  if ((value.wordSpeakers ?? []).some(([index, speaker, confidence]) => index < 0 || index >= tokenCount || speaker < 0 || confidence < 0 || confidence > 1)) {
    throw new ServiceError(400, "INVALID_REQUEST");
  }
  if ((value.lineSpeakers ?? []).some(([index, speaker, confidence]) => index < 0 || index >= value.lineSpans.length || speaker < 0 || confidence < 0 || confidence > 1)) {
    throw new ServiceError(400, "INVALID_REQUEST");
  }
  if ((value.speakerTurns ?? []).some(([speaker, start, end, confidence]) => speaker < 0 || start < 0 || end <= start || confidence < 0 || confidence > 1)) {
    throw new ServiceError(400, "INVALID_REQUEST");
  }

  let tokenOffset = 0;
  let previousLineEnd = 0;
  for (let lineIndex = 0; lineIndex < value.fingerprint.lens.length; lineIndex += 1) {
    const lineLength = value.fingerprint.lens[lineIndex]?.length ?? 0;
    const lineSpan = value.lineSpans[lineIndex];
    if (lineSpan === undefined) throw new ServiceError(400, "INVALID_REQUEST");
    const [lineStart, lineEnd] = lineSpan;
    if (lineStart < previousLineEnd) throw new ServiceError(400, "INVALID_REQUEST");
    if (value.durationMs !== undefined && lineEnd > value.durationMs) {
      throw new ServiceError(400, "INVALID_REQUEST");
    }
    const words = value.wordSpans.filter(
      ([index]) => index >= tokenOffset && index < tokenOffset + lineLength,
    );
    let previousEnd = lineStart;
    for (const [, start, end] of words) {
      if (start < lineStart || end > lineEnd || start < previousEnd) {
        throw new ServiceError(400, "INVALID_REQUEST");
      }
      previousEnd = end;
    }
    previousLineEnd = lineEnd;
    tokenOffset += lineLength;
  }
}
