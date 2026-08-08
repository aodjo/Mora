import { matchFingerprints } from "./alignment/matcher.js";
import { projectFingerprintAlignment, projectTextAlignment } from "./alignment/project.js";
import { ServiceError } from "./shared/errors.js";
import type { AlignmentResult, FingerprintAlignmentResult, StoredAlignment } from "./shared/types.js";
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
} from "./shared/validation.js";
import type { AlignmentRepository, Contribution } from "./storage/repository.js";
import { MAX_TOKENS, fingerprint, textHash, validateFingerprint } from "./tokenization/fingerprint.js";
import { publicTokens, tokenize } from "./tokenization/tokenizer.js";
import { tokenizeV2 } from "./tokenization/tokenizer-v2.js";
import type { SpeakerIndex, SpeakerTurn, Tokenization, TokenizerId } from "./shared/types.js";

interface Candidate {
  alignment: StoredAlignment;
  match: ReturnType<typeof matchFingerprints>;
}

function identifier(body: Record<string, unknown>): { isrc?: string; mbid?: string; artist?: string; title?: string; durationMs?: number } {
  if (body.isrc !== undefined) return { isrc: normalizeIsrc(body.isrc) };
  if (body.mbid !== undefined) return { mbid: normalizeMbid(body.mbid) };
  if (typeof body.artist === "string" && typeof body.title === "string") {
    const durationMs = optionalInteger(body.duration_ms, 86_400_000);
    if (durationMs === undefined) throw new ServiceError(400, "DURATION_REQUIRED");
    return {
      artist: body.artist.normalize("NFKC").trim().toLowerCase(),
      title: body.title.normalize("NFKC").trim().toLowerCase(),
      durationMs,
    };
  }
  throw new ServiceError(400, "INVALID_REQUEST");
}

function tokenizationFor(text: string, tokenizer: string, language = "und"): Tokenization {
  const result = tokenizer === "unilab-v2" ? tokenizeV2(text, language) : tokenize(text);
  // The same ceiling validateFingerprint applies to a submitted fingerprint. Without it a
  // single unauthenticated request can ask alignment for a matrix larger than the isolate.
  if (result.tokens.length > MAX_TOKENS) throw new ServiceError(413, "PAYLOAD_TOO_LARGE");
  return result;
}

function bestCandidate(alignments: StoredAlignment[], targetFor: (tokenizer: string) => ReturnType<typeof fingerprint>): Candidate {
  let best: Candidate | undefined;
  for (const alignment of alignments) {
    if (alignment.tokenizer !== "unilab-v1" && alignment.tokenizer !== "unilab-v2") continue;
    const match = matchFingerprints(alignment.fingerprint, targetFor(alignment.tokenizer));
    if (
      best === undefined ||
      match.confidence > best.match.confidence + 0.03 ||
      (Math.abs(match.confidence - best.match.confidence) <= 0.03 && (alignment.qualityScore ?? 0) > (best.alignment.qualityScore ?? 0)) ||
      (match.confidence === best.match.confidence &&
        (alignment.qualityScore ?? 0) === (best.alignment.qualityScore ?? 0) &&
        alignment.createdAt > best.alignment.createdAt)
    ) {
      best = { alignment, match };
    }
  }
  if (best === undefined) throw new ServiceError(404, "NOT_FOUND");
  return best;
}

function durationCompatible(alignment: StoredAlignment, requested: number | undefined): boolean {
  if (requested === undefined || alignment.durationMs === null) return true;
  const tolerance = Math.max(5_000, Math.round(alignment.durationMs * 0.02));
  return Math.abs(alignment.durationMs - requested) <= tolerance;
}

export class AlignmentService {
  constructor(readonly store: AlignmentRepository) {}

  async align(input: unknown): Promise<AlignmentResult> {
    const body = objectValue(input);
    const text = requiredString(body.text, { max: 1_000_000 });
    const durationMs = optionalInteger(body.duration_ms, 86_400_000);
    const language = optionalString(body.language, 35) ?? "und";
    const tokenizations = new Map<string, Tokenization>();
    const forTokenizer = (tokenizer: string): Tokenization => {
      const existing = tokenizations.get(tokenizer);
      if (existing !== undefined) return existing;
      const result = tokenizationFor(text, tokenizer, language);
      tokenizations.set(tokenizer, result);
      return result;
    };

    const resolvedIdentifier = identifier(body);
    const alignments = (await this.store.findAlignments(resolvedIdentifier)).filter((alignment) =>
      durationCompatible(alignment, durationMs),
    );
    if (alignments.length === 0) throw new ServiceError(404, "NOT_FOUND");
    if (resolvedIdentifier.artist !== undefined && new Set(alignments.map((item) => item.isrc)).size > 1)
      throw new ServiceError(409, "AMBIGUOUS_RECORDING");
    const exact = alignments.find((alignment) => textHash(forTokenizer(alignment.tokenizer).canonical) === alignment.textHash);
    const selected =
      exact === undefined
        ? bestCandidate(alignments, (tokenizer) => fingerprint(forTokenizer(tokenizer)))
        : { alignment: exact, match: matchFingerprints(exact.fingerprint, fingerprint(forTokenizer(exact.tokenizer))) };
    const selectedTokenization = forTokenizer(selected.alignment.tokenizer);
    const target = fingerprint(selectedTokenization);
    if (target.lens.length === 0) throw new ServiceError(400, "INVALID_REQUEST");
    return projectTextAlignment(selected.alignment, selectedTokenization, target, selected.match);
  }

  async alignFingerprint(input: unknown): Promise<FingerprintAlignmentResult> {
    const body = objectValue(input);
    const target = validateFingerprint(body.fingerprint);
    const durationMs = optionalInteger(body.duration_ms, 86_400_000);
    const resolvedIdentifier = identifier(body);
    const alignments = (await this.store.findAlignments(resolvedIdentifier)).filter((alignment) =>
      durationCompatible(alignment, durationMs),
    );
    if (alignments.length === 0) throw new ServiceError(404, "NOT_FOUND");
    if (resolvedIdentifier.artist !== undefined && new Set(alignments.map((item) => item.isrc)).size > 1)
      throw new ServiceError(409, "AMBIGUOUS_RECORDING");
    const selected = bestCandidate(alignments, () => target);
    return projectFingerprintAlignment(selected.alignment, target, selected.match);
  }

  tokenize(input: unknown): {
    tokenizer: TokenizerId;
    offset_unit: "codepoint";
    tokens: Array<[number, number, number]>;
  } {
    const body = objectValue(input);
    const text = requiredString(body.text, { max: 1_000_000 });
    const tokenizer = body.tokenizer === "unilab-v1" ? "unilab-v1" : "unilab-v2";
    const tokenization = tokenizationFor(text, tokenizer, optionalString(body.language, 35) ?? "und");
    return {
      tokenizer,
      offset_unit: "codepoint",
      tokens: publicTokens(tokenization),
    };
  }

  async contribute(input: unknown): Promise<{ alignment_id: number }> {
    const body = objectValue(input);
    const tokenizer = requiredString(body.tokenizer, { max: 64 });
    if (tokenizer !== "unilab-v1" && tokenizer !== "unilab-v2") throw new ServiceError(400, "UNSUPPORTED_TOKENIZER");
    const textHashValue = requiredString(body.text_hash, { min: 16, max: 16 }).toLowerCase();
    const contribution: Contribution = {
      isrc: normalizeIsrc(body.isrc),
      tokenizer,
      textHash: textHashValue,
      fingerprint: validateFingerprint(body.fingerprint),
      lineSpans: timeSpans(body.line_spans),
      wordSpans: indexedTimeSpans(body.word_spans),
      source: alignmentSource(body.source),
    };
    const mbid = body.mbid === undefined ? undefined : normalizeMbid(body.mbid);
    const durationMs = optionalInteger(body.duration_ms, 86_400_000);
    const contributor = optionalString(body.contributor, 256);
    if (mbid !== undefined) contribution.mbid = mbid;
    if (durationMs !== undefined) contribution.durationMs = durationMs;
    if (contributor !== undefined) contribution.contributor = contributor;
    contribution.speakerTurns = speakerTurns(body.speaker_turns);
    contribution.wordSpeakers = speakerIndices(body.word_speakers);
    contribution.lineSpeakers = speakerIndices(body.line_speakers);
    const qualityScore = typeof body.quality_score === "number" ? body.quality_score : undefined;
    if (qualityScore !== undefined) contribution.qualityScore = qualityScore;
    return { alignment_id: await this.store.contribute(contribution) };
  }
}

function speakerTurns(value: unknown): SpeakerTurn[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ServiceError(400, "INVALID_REQUEST");
  return value.map((row) => {
    if (!Array.isArray(row) || row.length !== 4 || row.some((part) => typeof part !== "number" || !Number.isFinite(part)))
      throw new ServiceError(400, "INVALID_REQUEST");
    return [row[0] as number, row[1] as number, row[2] as number, row[3] as number];
  });
}

function speakerIndices(value: unknown): SpeakerIndex[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ServiceError(400, "INVALID_REQUEST");
  return value.map((row) => {
    if (!Array.isArray(row) || row.length !== 3 || row.some((part) => typeof part !== "number" || !Number.isFinite(part)))
      throw new ServiceError(400, "INVALID_REQUEST");
    return [row[0] as number, row[1] as number, row[2] as number];
  });
}
