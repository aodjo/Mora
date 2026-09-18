import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "node:sqlite";
import { reopenForSource, type RevisionStore } from "../Server/src/admin/reselect.js";

/**
 * D1 대신 sqlite. `reopenForSource` 가 쓰는 만큼만 — prepare().bind().first()/all()/run().
 *
 * @param {InstanceType<typeof Database.DatabaseSync>} db - The database to wrap.
 * @returns {RevisionStore} The store the code under test expects.
 */
function store(db: InstanceType<typeof Database.DatabaseSync>): RevisionStore {
  const plain = (sql: string): string => sql.replace(/\?\d+/gu, "?");
  return {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        first: async <T>() => (db.prepare(plain(sql)).get(...(values as never[])) ?? null) as T | null,
        all: async <T>() => ({ results: db.prepare(plain(sql)).all(...(values as never[])) as T[] }),
        run: async () => db.prepare(plain(sql)).run(...(values as never[])),
      }),
    }),
  };
}

function open(): InstanceType<typeof Database.DatabaseSync> {
  const db = new Database.DatabaseSync(join(mkdtempSync(join(tmpdir(), "reselect-")), "admin.sqlite"));
  db.exec(`
    CREATE TABLE input_revisions (
      id TEXT PRIMARY KEY, recording_id TEXT NOT NULL, source_id TEXT NULL, parent_id TEXT NULL,
      state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','ready','superseded')),
      pipeline_profile TEXT NOT NULL, created_by TEXT NULL, created_at INTEGER NOT NULL, input_signature TEXT NULL);
    CREATE UNIQUE INDEX input_revision_signature_idx ON input_revisions(recording_id, input_signature) WHERE input_signature IS NOT NULL;
    CREATE TABLE jobs (id TEXT PRIMARY KEY, input_revision_id TEXT NOT NULL, state TEXT NOT NULL);
    CREATE TABLE lyric_texts (
      id TEXT PRIMARY KEY, input_revision_id TEXT NOT NULL, layer TEXT NOT NULL, language TEXT NOT NULL,
      text TEXT NOT NULL, text_hash TEXT NOT NULL, preprocessor TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1,
      review_required INTEGER NOT NULL DEFAULT 0, offset_map TEXT NOT NULL DEFAULT '[]', rules TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, UNIQUE (input_revision_id, layer, text_hash));
    CREATE TABLE lyric_sources (
      text_id TEXT NOT NULL, provider TEXT NOT NULL, provider_ref TEXT NULL, fetched_at INTEGER NOT NULL,
      PRIMARY KEY (text_id, provider));
    INSERT INTO input_revisions (id,recording_id,source_id,state,pipeline_profile,created_at,input_signature)
      VALUES ('rev-1','rec-1','src-1','ready','production-v1',1,'sig-1');
    INSERT INTO jobs (id,input_revision_id,state) VALUES ('job-1','rev-1','candidate_ready');
    INSERT INTO lyric_texts (id,input_revision_id,layer,language,text,text_hash,preprocessor,created_at)
      VALUES ('text-1','rev-1','original','ko','가사 한 줄','hash-1','lyrics-clean-v1',1),
             ('text-2','rev-1','original','ko','되살린 가사','hash-2','repeat-fill-v1',2);
    INSERT INTO lyric_sources (text_id,provider,provider_ref,fetched_at) VALUES ('text-1','melon',NULL,1),('text-1','vibe',NULL,1);
  `);
  return db;
}

test("a confirmed recording can be reopened: the lyrics come along, the old revision stays", async () => {
  const db = open();
  const got = await reopenForSource(store(db), "rec-1", "user-1", "rev-2", (index) => `new-${index}`, 9);
  assert.deepEqual(got, { input_revision_id: "rev-2", reopened: true });
  const made = db.prepare("SELECT source_id,parent_id,state,input_signature FROM input_revisions WHERE id='rev-2'").get() as Record<
    string,
    unknown
  >;
  assert.equal(made.source_id, null, "음원은 비운 채로 — 그것을 다시 고르려는 것이다");
  assert.equal(made.parent_id, "rev-1");
  assert.equal(made.state, "draft");
  assert.equal(made.input_signature, null, "지문이 있으면 수집기가 옛 회차로 되돌린다");
  const carried = db.prepare("SELECT id,text,preprocessor FROM lyric_texts WHERE input_revision_id='rev-2'").all() as Array<
    Record<string, string>
  >;
  assert.equal(carried.length, 1, "파이프라인이 만든 가사는 안 옮긴다");
  assert.equal(carried[0]?.text, "가사 한 줄");
  const providers = db
    .prepare("SELECT provider FROM lyric_sources WHERE text_id=? ORDER BY provider")
    .all(String(carried[0]?.id)) as Array<{ provider: string }>;
  assert.deepEqual(
    providers.map((one) => one.provider),
    ["melon", "vibe"],
    "누가 준 가사인지도 함께 옮긴다",
  );
  assert.equal((db.prepare("SELECT state FROM input_revisions WHERE id='rev-1'").get() as { state: string }).state, "ready");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM jobs").get() as { n: number }).n, 1, "옛 작업은 그대로 남는다");
  db.close();
});

test("asking twice does not pile up drafts", async () => {
  const db = open();
  const first = await reopenForSource(store(db), "rec-1", "user-1", "rev-2", (index) => `new-${index}`, 9);
  const again = await reopenForSource(store(db), "rec-1", "user-1", "rev-3", (index) => `other-${index}`, 10);
  assert.deepEqual(again, { input_revision_id: first.input_revision_id, reopened: false });
  assert.equal((db.prepare("SELECT COUNT(*) n FROM input_revisions").get() as { n: number }).n, 2);
  db.close();
});

test("a recording nobody has collected lyrics for is refused", async () => {
  const db = open();
  db.prepare("DELETE FROM lyric_texts").run();
  await assert.rejects(() => reopenForSource(store(db), "rec-1", "user-1", "rev-2", (index) => `new-${index}`, 9), /LYRICS_REQUIRED/u);
  db.close();
});

test("a recording with no revision at all is not found", async () => {
  const db = open();
  await assert.rejects(() => reopenForSource(store(db), "rec-none", "user-1", "rev-2", (index) => `new-${index}`, 9), /NOT_FOUND/u);
  db.close();
});
