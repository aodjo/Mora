import { textHash } from "../../../packages/core/src/tokenization/fingerprint.js";
import { tokenizeV2 } from "../../../packages/core/src/tokenization/tokenizer-v2.js";
import { ServiceError } from "../../../packages/core/src/shared/errors.js";
import type { AlignmentCandidate } from "../../../packages/contracts/src/index.js";

/** 이 파일이 쓰는 것만큼의 D1. 시험에서 sqlite 로 갈아 끼울 수 있게 좁게 적는다. */
export interface LyricStore {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

/**
 * Which lines a restored lyric had put back, read off the text's rules.
 *
 * @param {unknown} rules - The lyric text's `rules` column.
 * @returns {number[]} Line numbers the Generator inserted, or an empty list.
 */
export function filledLines(rules: unknown): number[] {
  try {
    const got = JSON.parse(String(rules ?? "[]")) as unknown;
    const filled = (got as { filled?: unknown })?.filled;
    return Array.isArray(filled) ? filled.filter((one): one is number => typeof one === "number") : [];
  } catch {
    return [];
  }
}

export async function sungVariant(env: LyricStore, inputId: string, candidate: AlignmentCandidate): Promise<string> {
  const text = typeof candidate.text === "string" ? candidate.text.trim() : "";
  if (!text) return candidate.variant_id;
  const parent = await env
    .prepare("SELECT language FROM lyric_texts WHERE id=?1 AND input_revision_id=?2")
    .bind(candidate.variant_id, inputId)
    .first<{ language: string }>();
  if (parent === null) throw new ServiceError(409, "CONFLICT");
  const hash = textHash(tokenizeV2(text, parent.language).canonical);
  const found = await env
    .prepare("SELECT id FROM lyric_texts WHERE input_revision_id=?1 AND layer='original' AND text_hash=?2")
    .bind(inputId, hash)
    .first<{ id: string }>();
  if (found !== null) return found.id;
  const id = crypto.randomUUID();
  await env
    .prepare(
      `INSERT INTO lyric_texts (id,input_revision_id,layer,language,text,text_hash,preprocessor,confidence,review_required,offset_map,rules,created_at)
     VALUES (?1,?2,'original',?3,?4,?5,'repeat-fill-v1',1,1,'[]',?6,?7)`,
    )
    .bind(
      id,
      inputId,
      parent.language,
      text,
      hash,
      JSON.stringify({ repeat_of: candidate.variant_id, filled: candidate.filled ?? [] }),
      Date.now(),
    )
    .run();
  return id;
}
