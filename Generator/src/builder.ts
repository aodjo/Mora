import { ServiceError } from "../../packages/core/src/shared/errors.js";
import {
  alignmentSource,
  indexedTimeSpans,
  normalizeIsrc,
  normalizeMbid,
  objectValue,
  optionalInteger,
  optionalString,
  requiredString,
  timeSpans,
} from "../../packages/core/src/shared/validation.js";
import { validateContribution } from "../../packages/core/src/storage/contribution.js";
import type { Contribution } from "../../packages/core/src/storage/repository.js";
import { fingerprint, textHash } from "../../packages/core/src/tokenization/fingerprint.js";
import { tokenize } from "../../packages/core/src/tokenization/tokenizer.js";
import type {
  AlignmentSource,
  Fingerprint,
  IndexedTimeSpan,
  TimeSpan,
} from "../../packages/core/src/shared/types.js";

export interface ContributionPayload {
  isrc: string;
  mbid?: string;
  duration_ms?: number;
  tokenizer: "unilab-v1";
  text_hash: string;
  fingerprint: Fingerprint;
  line_spans: TimeSpan[];
  word_spans: IndexedTimeSpan[];
  source: AlignmentSource;
  contributor?: string;
}

export function buildContribution(input: unknown): Contribution {
  const body = objectValue(input);
  const text = requiredString(body.text, { max: 1_000_000 });
  const tokenization = tokenize(text);
  const value: Contribution = {
    isrc: normalizeIsrc(body.isrc),
    tokenizer: "unilab-v1",
    textHash: textHash(tokenization.canonical),
    fingerprint: fingerprint(tokenization),
    lineSpans: timeSpans(body.line_spans),
    wordSpans: indexedTimeSpans(body.word_spans),
    source: alignmentSource(body.source),
  };
  if (value.fingerprint.lens.length === 0) throw new ServiceError(400, "INVALID_REQUEST");

  const mbid = body.mbid === undefined ? undefined : normalizeMbid(body.mbid);
  const durationMs = optionalInteger(body.duration_ms, 86_400_000);
  const contributor = optionalString(body.contributor, 256);
  if (mbid !== undefined) value.mbid = mbid;
  if (durationMs !== undefined) value.durationMs = durationMs;
  if (contributor !== undefined) value.contributor = contributor;
  validateContribution(value);
  return value;
}

export function toContributionPayload(value: Contribution): ContributionPayload {
  return {
    isrc: value.isrc,
    ...(value.mbid === undefined ? {} : { mbid: value.mbid }),
    ...(value.durationMs === undefined ? {} : { duration_ms: value.durationMs }),
    tokenizer: "unilab-v1",
    text_hash: value.textHash,
    fingerprint: value.fingerprint,
    line_spans: value.lineSpans,
    word_spans: value.wordSpans,
    source: value.source,
    ...(value.contributor === undefined ? {} : { contributor: value.contributor }),
  };
}

export function buildContributionPayload(input: unknown): ContributionPayload {
  return toContributionPayload(buildContribution(input));
}
