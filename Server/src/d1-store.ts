import type { AlignmentSource, Fingerprint, IndexedTimeSpan, StoredAlignment, TimeSpan } from "../../packages/core/src/shared/types.js";
import { validateContribution } from "../../packages/core/src/storage/contribution.js";
import type { AlignmentRepository, Contribution, RecordingIdentifier } from "../../packages/core/src/storage/repository.js";

interface AlignmentRow {
  id: number;
  isrc: string;
  text_hash: string;
  tokenizer: string;
  fp_lens: ArrayBuffer | number[];
  fp_types: ArrayBuffer | number[];
  line_spans: ArrayBuffer | number[];
  word_spans: ArrayBuffer | number[];
  source: string;
  contributor: string | null;
  created_at: number;
  duration_ms: number | null;
  speaker_turns: ArrayBuffer | number[];
  word_speakers: ArrayBuffer | number[];
  line_speakers: ArrayBuffer | number[];
  quality_score: number;
}

function encode(value: unknown): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function decode<T>(value: ArrayBuffer | number[]): T {
  const bytes = Array.isArray(value) ? Uint8Array.from(value) : new Uint8Array(value);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function source(value: string): AlignmentSource {
  return value === "manual" ? "manual" : "forced-align";
}

function fromRow(row: AlignmentRow): StoredAlignment {
  return {
    id: row.id,
    isrc: row.isrc,
    textHash: row.text_hash,
    tokenizer: row.tokenizer,
    fingerprint: {
      lens: decode<number[][]>(row.fp_lens),
      types: decode<Fingerprint["types"]>(row.fp_types),
    },
    lineSpans: decode<TimeSpan[]>(row.line_spans),
    wordSpans: decode<IndexedTimeSpan[]>(row.word_spans),
    source: source(row.source),
    contributor: row.contributor,
    createdAt: row.created_at,
    durationMs: row.duration_ms,
    speakerTurns: decode(row.speaker_turns),
    wordSpeakers: decode(row.word_speakers),
    lineSpeakers: decode(row.line_speakers),
    qualityScore: row.quality_score,
  };
}

export class D1AlignmentStore implements AlignmentRepository {
  constructor(private readonly database: D1Database) {}

  async findAlignments(identifier: RecordingIdentifier): Promise<StoredAlignment[]> {
    let statement: D1PreparedStatement;
    if (identifier.isrc !== undefined) {
      statement = this.database
        .prepare(
          `
          SELECT a.*, r.duration_ms FROM public_alignment a
          JOIN public_recording r ON r.isrc = a.isrc
          WHERE a.isrc = ?1 AND a.active = 1 ORDER BY a.created_at DESC
        `,
        )
        .bind(identifier.isrc);
    } else if (identifier.mbid !== undefined) {
      statement = this.database
        .prepare(
          `
          SELECT a.*, r.duration_ms FROM public_alignment a
          JOIN public_recording r ON r.isrc = a.isrc
          WHERE r.mbid = ?1 AND a.active = 1 ORDER BY a.created_at DESC
        `,
        )
        .bind(identifier.mbid);
    } else if (identifier.artist !== undefined && identifier.title !== undefined && identifier.durationMs !== undefined) {
      statement = this.database
        .prepare(
          `
        SELECT a.*, r.duration_ms FROM public_alignment a
        JOIN public_recording r ON r.isrc = a.isrc
        WHERE r.artist_key = ?1 AND r.title_key = ?2 AND ABS(r.duration_ms - ?3) <= MAX(5000, r.duration_ms * 0.02)
          AND a.active = 1
        ORDER BY a.quality_score DESC, a.created_at DESC
      `,
        )
        .bind(identifier.artist, identifier.title, identifier.durationMs);
    } else {
      return [];
    }

    const result = await statement.all<AlignmentRow>();
    return result.results.map(fromRow);
  }

  async contribute(value: Contribution): Promise<number> {
    validateContribution(value);
    const recording = this.database
      .prepare(
        `
        INSERT INTO public_recording (isrc, mbid, duration_ms)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(isrc) DO UPDATE SET
          mbid = COALESCE(excluded.mbid, public_recording.mbid),
          duration_ms = COALESCE(excluded.duration_ms, public_recording.duration_ms)
      `,
      )
      .bind(value.isrc, value.mbid ?? null, value.durationMs ?? null);
    const alignment = this.database
      .prepare(
        `
        INSERT INTO public_alignment (
          isrc, text_hash, tokenizer, fp_lens, fp_types,
          line_spans, word_spans, speaker_turns, word_speakers, line_speakers,
          quality_score, source, contributor, active, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 1, ?14)
        ON CONFLICT(isrc, text_hash, tokenizer) DO UPDATE SET
          fp_lens = excluded.fp_lens,
          fp_types = excluded.fp_types,
          line_spans = excluded.line_spans,
          word_spans = excluded.word_spans,
          speaker_turns = excluded.speaker_turns,
          word_speakers = excluded.word_speakers,
          line_speakers = excluded.line_speakers,
          quality_score = excluded.quality_score,
          source = excluded.source,
          contributor = excluded.contributor,
          created_at = excluded.created_at
        RETURNING id
      `,
      )
      .bind(
        value.isrc,
        value.textHash,
        value.tokenizer,
        encode(value.fingerprint.lens),
        encode(value.fingerprint.types),
        encode(value.lineSpans),
        encode(value.wordSpans),
        encode(value.speakerTurns ?? []),
        encode(value.wordSpeakers ?? []),
        encode(value.lineSpeakers ?? []),
        value.qualityScore ?? 0,
        value.source,
        value.contributor ?? null,
        Date.now(),
      );

    const results = await this.database.batch([recording, alignment]);
    const id = (results[1]?.results[0] as { id?: unknown } | undefined)?.id;
    if (typeof id !== "number") throw new Error("D1_WRITE_FAILED");
    return id;
  }
}
