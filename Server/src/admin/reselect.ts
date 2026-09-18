import { ServiceError } from "../../../packages/core/src/shared/errors.js";

/** 이 파일이 쓰는 것만큼의 D1. 시험에서 sqlite 로 갈아 끼울 수 있게 좁게 적는다. */
export interface RevisionStore {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<unknown>;
    };
  };
}

/**
 * Open a fresh revision of a recording so its audio can be chosen again.
 *
 * 소스는 회차 하나에 한 번만 확정된다 — 그 회차에 작업이 걸리고, 작업은 그 음원으로 만든
 * 후보를 낳는다. 그래서 잘못된 음원을 골랐다는 것을 나중에 알아도 화면에는 「이미 작업이
 * 만들어져 소스를 바꿀 수 없습니다」뿐이었다. 지운 자리에서 다시 시작하는 대신, 가사를 그대로
 * 옮긴 새 회차를 연다: 옛 회차와 그 후보는 그대로 남고, 새 회차가 다른 음원을 받는다.
 *
 * 파이프라인이 만든 가사(반복을 되살린 판)는 옮기지 않는다. 그것은 음원에서 나온 것이라 음원이
 * 바뀌면 다시 만들어져야 한다.
 *
 * @param {RevisionStore} db - The admin database.
 * @param {string} recordingId - The recording to reopen.
 * @param {string | null} actorId - Who asked.
 * @param {string} revisionId - The id to give the new revision.
 * @param {(index: number) => string} textId - Ids for the copied lyric texts.
 * @param {number} now - The current time in ms.
 * @returns {Promise<{ input_revision_id: string; reopened: boolean }>} The draft to choose a source
 *   on, and whether it was made here (false when one was already open).
 * @throws {ServiceError} 404 when the recording has no revision, 409 when it has no lyrics to carry.
 */
export async function reopenForSource(
  db: RevisionStore,
  recordingId: string,
  actorId: string | null,
  revisionId: string,
  textId: (index: number) => string,
  now: number,
): Promise<{ input_revision_id: string; reopened: boolean }> {
  const open = await db
    .prepare(
      `SELECT i.id FROM input_revisions i LEFT JOIN jobs j ON j.input_revision_id=i.id
       WHERE i.recording_id=?1 AND i.state='draft' AND j.id IS NULL ORDER BY i.created_at DESC LIMIT 1`,
    )
    .bind(recordingId)
    .first<{ id: string }>();
  if (open !== null) return { input_revision_id: open.id, reopened: false };

  const latest = await db
    .prepare("SELECT id FROM input_revisions WHERE recording_id=?1 ORDER BY created_at DESC LIMIT 1")
    .bind(recordingId)
    .first<{ id: string }>();
  if (latest === null) throw new ServiceError(404, "NOT_FOUND");
  const lyrics = await db
    .prepare(
      `SELECT id,layer,language,text,text_hash,preprocessor,confidence,review_required,offset_map,rules
       FROM lyric_texts WHERE input_revision_id=?1 AND preprocessor<>'repeat-fill-v1' ORDER BY created_at`,
    )
    .bind(latest.id)
    .all<{
      id: string;
      layer: string;
      language: string;
      text: string;
      text_hash: string;
      preprocessor: string;
      confidence: number;
      review_required: number;
      offset_map: string;
      rules: string;
    }>();
  if (lyrics.results.length === 0) throw new ServiceError(409, "LYRICS_REQUIRED");

  //: 새 회차에는 지문을 달지 않는다. 지문이 있으면 수집기의 겹침 검사가 「같은 입력」으로 보고
  //: 옛 회차를 돌려주는데, 여기서 바라는 것은 정확히 그 반대다 — 같은 가사로 다른 음원을.
  await db
    .prepare(
      `INSERT INTO input_revisions (id,recording_id,source_id,parent_id,state,pipeline_profile,created_by,created_at,input_signature)
       VALUES (?1,?2,NULL,?3,'draft','production-v1',?4,?5,NULL)`,
    )
    .bind(revisionId, recordingId, latest.id, actorId, now)
    .run();
  for (const [index, lyric] of lyrics.results.entries()) {
    const id = textId(index);
    await db
      .prepare(
        `INSERT INTO lyric_texts (id,input_revision_id,layer,language,text,text_hash,preprocessor,confidence,review_required,offset_map,rules,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
      )
      .bind(
        id,
        revisionId,
        lyric.layer,
        lyric.language,
        lyric.text,
        lyric.text_hash,
        lyric.preprocessor,
        lyric.confidence,
        lyric.review_required,
        lyric.offset_map,
        lyric.rules,
        now,
      )
      .run();
    //: 누가 준 가사인지도 함께 옮긴다. 화면이 제공처 이름으로 후보를 가리키기 때문이다.
    await db
      .prepare(
        `INSERT INTO lyric_sources (text_id,provider,provider_ref,fetched_at)
         SELECT ?1,provider,provider_ref,fetched_at FROM lyric_sources WHERE text_id=?2`,
      )
      .bind(id, lyric.id)
      .run();
  }
  return { input_revision_id: revisionId, reopened: true };
}
