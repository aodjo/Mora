import { createHash } from "node:crypto";
import { ServiceError } from "../shared/errors.js";
import { activeLines } from "./tokenizer.js";
import type { Fingerprint, TokenType, Tokenization } from "../shared/types.js";

export function textHash(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

export function fingerprint(tokenization: Tokenization): Fingerprint {
  const lens: number[][] = [];
  const types: TokenType[][] = [];

  for (const line of activeLines(tokenization)) {
    lens.push(line.tokenIndices.map((index) => tokenization.tokens[index]?.length ?? 0));
    types.push(line.tokenIndices.map((index) => tokenization.tokens[index]?.type ?? 3));
  }
  return { lens, types };
}

export function validateFingerprint(value: unknown): Fingerprint {
  if (typeof value !== "object" || value === null) {
    throw new ServiceError(400, "INVALID_REQUEST");
  }

  const candidate = value as { lens?: unknown; types?: unknown };
  if (!Array.isArray(candidate.lens) || !Array.isArray(candidate.types)) {
    throw new ServiceError(400, "INVALID_REQUEST");
  }
  if (candidate.lens.length !== candidate.types.length || candidate.lens.length === 0) {
    throw new ServiceError(400, "INVALID_REQUEST");
  }

  const lens: number[][] = [];
  const types: TokenType[][] = [];
  let tokenCount = 0;

  for (let lineIndex = 0; lineIndex < candidate.lens.length; lineIndex += 1) {
    const rawLens = candidate.lens[lineIndex];
    const rawTypes = candidate.types[lineIndex];
    if (!Array.isArray(rawLens) || !Array.isArray(rawTypes) || rawLens.length !== rawTypes.length) {
      throw new ServiceError(400, "INVALID_REQUEST");
    }
    if (rawLens.length === 0) throw new ServiceError(400, "INVALID_REQUEST");

    const lineLens: number[] = [];
    const lineTypes: TokenType[] = [];
    for (let index = 0; index < rawLens.length; index += 1) {
      const length = rawLens[index];
      const type = rawTypes[index];
      if (!Number.isInteger(length) || (length as number) <= 0 || (length as number) > 10_000) {
        throw new ServiceError(400, "INVALID_REQUEST");
      }
      if (!Number.isInteger(type) || ![0, 1, 2, 3].includes(type as number)) {
        throw new ServiceError(400, "INVALID_REQUEST");
      }
      lineLens.push(length as number);
      lineTypes.push(type as TokenType);
      tokenCount += 1;
    }
    lens.push(lineLens);
    types.push(lineTypes);
  }

  if (tokenCount > 100_000) throw new ServiceError(413, "PAYLOAD_TOO_LARGE");
  return { lens, types };
}

export function fingerprintTokenCount(value: Fingerprint): number {
  return value.lens.reduce((total, line) => total + line.length, 0);
}

export function fingerprintHash(value: Fingerprint): string {
  return createHash("sha256")
    .update(JSON.stringify([value.lens, value.types]), "utf8")
    .digest("hex")
    .slice(0, 16);
}
