import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "node:sqlite";

/**
 * The schema, exercised the way the API writes it.
 *
 * Five services carrying one lyric used to make five rows, and the Generator force-aligned
 * each — a third of all alignment work measured. The text is stored once; who supplied it is
 * recorded against it.
 */
function open(): InstanceType<typeof Database.DatabaseSync> {
  const database = new Database.DatabaseSync(join(mkdtempSync(join(tmpdir(), "lyrics-")), "admin.sqlite"));
  database.exec(`
    CREATE TABLE lyric_texts (
      id TEXT PRIMARY KEY, input_revision_id TEXT NOT NULL, layer TEXT NOT NULL, language TEXT NOT NULL,
      text TEXT NOT NULL, text_hash TEXT NOT NULL, preprocessor TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE (input_revision_id, layer, text_hash));
    CREATE TABLE lyric_sources (
      text_id TEXT NOT NULL REFERENCES lyric_texts(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, provider_ref TEXT NULL, fetched_at INTEGER NOT NULL,
      PRIMARY KEY (text_id, provider));
  `);
  return database;
}

/** storeLyricText 가 하는 일을 그대로 옮긴 것. */
function store(db: ReturnType<typeof open>, revision: string, provider: string, hash: string, text: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO lyric_texts (id,input_revision_id,layer,language,text,text_hash,preprocessor,created_at)
     VALUES (?,?,'original','ko',?,?,'v2',1)`,
  ).run(`${revision}-${provider}-${hash}`, revision, text, hash);
  const held = db
    .prepare("SELECT id FROM lyric_texts WHERE input_revision_id=? AND layer='original' AND text_hash=?")
    .get(revision, hash) as { id: string } | undefined;
  if (held === undefined) return;
  db.prepare("INSERT OR IGNORE INTO lyric_sources (text_id,provider,provider_ref,fetched_at) VALUES (?,?,NULL,1)").run(held.id, provider);
}

test("four services with the same words make one thing to align", () => {
  const db = open();
  for (const provider of ["melon", "bugs", "genie", "flo"]) store(db, "rev-1", provider, "hash-swim", "Swim, swim");
  store(db, "rev-1", "vibe", "hash-translated", "수영해, 수영해");

  const texts = db.prepare("SELECT COUNT(*) AS n FROM lyric_texts").get() as { n: number };
  assert.equal(texts.n, 2, "글자는 두 벌 — 원문과 번역본");
  // 정렬은 글자에 붙으므로 이것이 곧 Generator 가 할 일의 개수다.
  const sources = db.prepare("SELECT COUNT(*) AS n FROM lyric_sources").get() as { n: number };
  assert.equal(sources.n, 5, "누가 줬는지는 다섯 곳 모두 남는다");

  const agreed = db
    .prepare(
      "SELECT group_concat(provider) AS who FROM lyric_sources WHERE text_id=(SELECT id FROM lyric_texts WHERE text_hash='hash-swim')",
    )
    .get() as { who: string };
  assert.deepEqual(agreed.who.split(",").sort(), ["bugs", "flo", "genie", "melon"]);
  db.close();
});

test("the same service answering twice does not double-count itself", () => {
  const db = open();
  store(db, "rev-1", "melon", "hash-swim", "Swim, swim");
  store(db, "rev-1", "melon", "hash-swim", "Swim, swim");
  const sources = db.prepare("SELECT COUNT(*) AS n FROM lyric_sources").get() as { n: number };
  assert.equal(sources.n, 1);
  db.close();
});

test("a different song's identical lyric is its own row", () => {
  // 회차가 다르면 별개다 — 어떤 음원에 맞출지가 다르기 때문이다.
  const db = open();
  store(db, "rev-1", "melon", "hash-swim", "Swim, swim");
  store(db, "rev-2", "melon", "hash-swim", "Swim, swim");
  const texts = db.prepare("SELECT COUNT(*) AS n FROM lyric_texts").get() as { n: number };
  assert.equal(texts.n, 2);
  db.close();
});
