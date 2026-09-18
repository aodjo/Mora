import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "node:sqlite";
import { filledLines, sungVariant, type LyricStore } from "../Server/src/admin/sung-variant.js";
import type { AlignmentCandidate } from "../packages/contracts/src/index.js";

/**
 * D1 대신 sqlite. `sungVariant` 가 쓰는 만큼만 흉내 낸다 — prepare().bind().first()/run().
 *
 * @param {InstanceType<typeof Database.DatabaseSync>} db - The database to wrap.
 * @returns {LyricStore} The store the code under test expects.
 */
function store(db: InstanceType<typeof Database.DatabaseSync>): LyricStore {
  return {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        first: async <T>() => (db.prepare(numbered(sql)).get(...(values as never[])) ?? null) as T | null,
        run: async () => db.prepare(numbered(sql)).run(...(values as never[])),
      }),
    }),
  };
}

/** sqlite 의 node 판은 ?1 을 그대로 받지만 순서 인자와 섞이면 헷갈린다. ? 로 바꿔 자리대로 묶는다. */
function numbered(sql: string): string {
  return sql.replace(/\?\d+/gu, "?");
}

function open(): InstanceType<typeof Database.DatabaseSync> {
  const db = new Database.DatabaseSync(join(mkdtempSync(join(tmpdir(), "repeat-")), "admin.sqlite"));
  db.exec(`
    CREATE TABLE lyric_texts (
      id TEXT PRIMARY KEY, input_revision_id TEXT NOT NULL,
      layer TEXT NOT NULL CHECK (layer IN ('raw', 'original', 'translation', 'romanization')),
      language TEXT NOT NULL, text TEXT NOT NULL, text_hash TEXT NOT NULL, preprocessor TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1, review_required INTEGER NOT NULL DEFAULT 0,
      offset_map TEXT NOT NULL DEFAULT '[]', rules TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL,
      UNIQUE (input_revision_id, layer, text_hash));
  `);
  db.prepare(
    `INSERT INTO lyric_texts (id,input_revision_id,layer,language,text,text_hash,preprocessor,created_at)
     VALUES ('var-1','rev-1','original','ko','난 너랑 결혼했을걸\n난 너랑 결혼했을 거야','hash-short','lyrics-clean-v1',1)`,
  ).run();
  return db;
}

const SUNG = "난 너랑 결혼했을걸\n난 너랑 결혼했을걸\n난 너랑 결혼했을걸\n난 너랑 결혼했을 거야";

function candidate(extra: Partial<AlignmentCandidate>): AlignmentCandidate {
  return {
    variant_id: "var-1",
    tokenizer: "unilab-v2",
    text_hash: "x",
    fingerprint: { lens: [], types: [] },
    line_spans: [],
    word_spans: [],
    speaker_turns: [],
    word_speakers: [],
    line_speakers: [],
    quality: {},
    ...extra,
  } as AlignmentCandidate;
}

test("a candidate with restored repeats gets its own lyric row, and the provider's text is untouched", async () => {
  const db = open();
  const id = await sungVariant(store(db), "rev-1", candidate({ text: SUNG, filled: [1, 2] }));
  assert.notEqual(id, "var-1");
  const rows = db.prepare("SELECT id,text,preprocessor,rules,review_required FROM lyric_texts ORDER BY created_at").all() as Array<
    Record<string, string | number>
  >;
  assert.equal(rows.length, 2, "제공처 가사 한 벌, 되살린 가사 한 벌");
  assert.equal(rows[0]?.text, "난 너랑 결혼했을걸\n난 너랑 결혼했을 거야");
  assert.equal(rows[1]?.preprocessor, "repeat-fill-v1");
  assert.equal(rows[1]?.text, SUNG);
  assert.equal(rows[1]?.review_required, 1, "되살린 가사는 사람이 한 번 봐야 한다");
  assert.deepEqual(JSON.parse(String(rows[1]?.rules)), { repeat_of: "var-1", filled: [1, 2] });
  db.close();
});

test("the same restored lyric twice is one row", async () => {
  const db = open();
  const first = await sungVariant(store(db), "rev-1", candidate({ text: SUNG, filled: [1, 2] }));
  const again = await sungVariant(store(db), "rev-1", candidate({ text: SUNG, filled: [1, 2] }));
  assert.equal(first, again);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM lyric_texts").get() as { n: number }).n, 2);
  db.close();
});

test("a candidate without restored repeats stays on the provider's lyric", async () => {
  const db = open();
  assert.equal(await sungVariant(store(db), "rev-1", candidate({})), "var-1");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM lyric_texts").get() as { n: number }).n, 1);
  db.close();
});

test("restored line numbers are read back, and rubbish reads as none", () => {
  assert.deepEqual(filledLines(JSON.stringify({ repeat_of: "var-1", filled: [1, 2] })), [1, 2]);
  assert.deepEqual(filledLines("[]"), []);
  assert.deepEqual(filledLines(null), []);
  assert.deepEqual(filledLines("{"), []);
});
