import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { ServiceError } from "../shared/errors.js";
import type {
  AlignmentSource,
  Fingerprint,
  IndexedTimeSpan,
  StoredAlignment,
  TimeSpan,
} from "../shared/types.js";
import type { AlignmentRepository, Contribution, RecordingIdentifier } from "./repository.js";
import { validateContribution } from "./contribution.js";

interface AlignmentRow {
  id: number;
  isrc: string;
  text_hash: string;
  tokenizer: string;
  fp_lens: Uint8Array;
  fp_types: Uint8Array;
  line_spans: Uint8Array;
  word_spans: Uint8Array;
  source: AlignmentSource;
  contributor: string | null;
  created_at: number;
  duration_ms: number | null;
  speaker_turns: Uint8Array;
  word_speakers: Uint8Array;
  line_speakers: Uint8Array;
  quality_score: number;
}

function encode(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function decode<T>(value: Uint8Array): T {
  return JSON.parse(Buffer.from(value).toString("utf8")) as T;
}

export class AlignmentStore implements AlignmentRepository {
  readonly filePath: string | null;
  readonly #database: DatabaseSync;

  constructor(path = "data/service.sqlite") {
    this.filePath = path === ":memory:" ? null : resolve(path);
    if (this.filePath !== null) mkdirSync(dirname(this.filePath), { recursive: true });
    this.#database = new DatabaseSync(this.filePath ?? ":memory:");
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#migrate();
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS recording (
        isrc TEXT PRIMARY KEY,
        mbid TEXT NULL UNIQUE,
        artist_key TEXT NULL,
        title_key TEXT NULL,
        duration_ms INTEGER NULL CHECK (duration_ms IS NULL OR duration_ms >= 0)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS alignment (
        id INTEGER PRIMARY KEY,
        isrc TEXT NOT NULL REFERENCES recording(isrc),
        text_hash TEXT NOT NULL CHECK (length(text_hash) = 16),
        tokenizer TEXT NOT NULL,
        fp_lens BLOB NOT NULL,
        fp_types BLOB NOT NULL,
        line_spans BLOB NOT NULL,
        word_spans BLOB NOT NULL,
        speaker_turns BLOB NOT NULL,
        word_speakers BLOB NOT NULL,
        line_speakers BLOB NOT NULL,
        quality_score REAL NOT NULL DEFAULT 0,
        source TEXT NOT NULL CHECK (source IN ('manual', 'forced-align')),
        contributor TEXT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (isrc, text_hash, tokenizer)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS alignment_isrc_idx ON alignment(isrc);
      CREATE INDEX IF NOT EXISTS alignment_hash_idx ON alignment(isrc, text_hash, tokenizer);
    `);
  }

  close(): void {
    this.#database.close();
  }

  checkpoint(): void {
    this.#database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  contribute(value: Contribution): number {
    validateContribution(value);
    const transaction = this.#database.prepare("BEGIN IMMEDIATE");
    transaction.run();
    try {
      this.#database
        .prepare(`
          INSERT INTO recording (isrc, mbid, duration_ms)
          VALUES (?, ?, ?)
          ON CONFLICT(isrc) DO UPDATE SET
            mbid = COALESCE(excluded.mbid, recording.mbid),
            duration_ms = COALESCE(excluded.duration_ms, recording.duration_ms)
        `)
        .run(value.isrc, value.mbid ?? null, value.durationMs ?? null);

      const result = this.#database
        .prepare(`
          INSERT INTO alignment (
            isrc, text_hash, tokenizer, fp_lens, fp_types,
            line_spans, word_spans, speaker_turns, word_speakers, line_speakers,
            quality_score, source, contributor, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        `)
        .get(
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
        ) as { id: number } | undefined;
      this.#database.exec("COMMIT");
      if (result === undefined) throw new ServiceError(500, "INTERNAL");
      return result.id;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      if (error instanceof ServiceError) throw error;
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw new ServiceError(409, "CONFLICT");
      }
      throw error;
    }
  }

  findAlignments(identifier: RecordingIdentifier): StoredAlignment[] {
    let rows: AlignmentRow[];
    if (identifier.isrc !== undefined) {
      rows = this.#database
        .prepare(`
          SELECT a.*, r.duration_ms FROM alignment a
          JOIN recording r ON r.isrc = a.isrc
          WHERE a.isrc = ? ORDER BY a.created_at DESC
        `)
        .all(identifier.isrc as SQLInputValue) as unknown as AlignmentRow[];
    } else if (identifier.mbid !== undefined) {
      rows = this.#database
        .prepare(`
          SELECT a.* FROM alignment a
          JOIN recording r ON r.isrc = a.isrc
          WHERE r.mbid = ?
          ORDER BY a.created_at DESC
        `)
        .all(identifier.mbid as SQLInputValue) as unknown as AlignmentRow[];
    } else if (identifier.artist !== undefined && identifier.title !== undefined && identifier.durationMs !== undefined) {
      rows = this.#database.prepare(`SELECT a.*, r.duration_ms FROM alignment a JOIN recording r ON r.isrc=a.isrc WHERE r.artist_key=? AND r.title_key=? AND ABS(r.duration_ms-?)<=MAX(5000,r.duration_ms*0.02) ORDER BY a.created_at DESC`).all(identifier.artist, identifier.title, identifier.durationMs) as unknown as AlignmentRow[];
    } else {
      return [];
    }
    return rows.map((row) => ({
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
      source: row.source,
      contributor: row.contributor,
      createdAt: row.created_at,
      durationMs: row.duration_ms,
      speakerTurns: decode(row.speaker_turns),
      wordSpeakers: decode(row.word_speakers),
      lineSpeakers: decode(row.line_speakers),
      qualityScore: row.quality_score,
    }));
  }
}
