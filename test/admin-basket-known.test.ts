import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "node:sqlite";
import { alreadyCollected, songKey, type BasketStore } from "../Server/src/admin/basket.js";

/**
 * D1 대신 sqlite. `alreadyCollected` 가 쓰는 만큼만 — prepare().bind().all().
 *
 * @param {InstanceType<typeof Database.DatabaseSync>} db - The database to wrap.
 * @returns {BasketStore} The store the code under test expects.
 */
function store(db: InstanceType<typeof Database.DatabaseSync>): BasketStore {
  const plain = (sql: string): string => sql.replace(/\?\d+/gu, "?");
  return {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        all: async <T>() => ({ results: db.prepare(plain(sql)).all(...(values as never[])) as T[] }),
      }),
    }),
  };
}

function open(rows: Array<[string, string, string | null]>): BasketStore {
  const db = new Database.DatabaseSync(join(mkdtempSync(join(tmpdir(), "basket-")), "admin.sqlite"));
  db.exec("CREATE TABLE recordings (id TEXT PRIMARY KEY, artist TEXT NOT NULL, title TEXT NOT NULL, isrc TEXT NULL)");
  for (const [artist, title, isrc] of rows) {
    db.prepare("INSERT INTO recordings (id,artist,title,isrc) VALUES (?,?,?,?)").run(`${artist}:${title}`, artist, title, isrc);
  }
  return store(db);
}

test("a song the catalogue already holds is recognised before it is kept", async () => {
  const db = open([["HYUKOH", "위잉위잉", "KRA401200001"]]);
  const known = await alreadyCollected(db, [
    { artist: "HYUKOH", title: "위잉위잉" },
    { artist: "Tsuku", title: "낙사" },
  ]);
  assert.equal(known.has(songKey("HYUKOH", "위잉위잉")), true);
  assert.equal(known.has(songKey("Tsuku", "낙사")), false);
});

test("the same song under a different spelling is still the same song", async () => {
  // 제공처마다 대소문자가 다르다. 그것 때문에 같은 곡을 두 번 하면 안 된다.
  const db = open([["HYUKOH", "Wi Ing Wi Ing", null]]);
  const known = await alreadyCollected(db, [{ artist: "hyukoh", title: "wi ing wi ing" }]);
  assert.equal(known.size, 1);
});

test("a different name with the same ISRC is caught", async () => {
  // 영어 제목과 한글 제목으로 두 번 들어오는 곡이 있다. ISRC 는 그것을 하나로 묶는다.
  const db = open([["혁오", "위잉위잉", "KRA401200001"]]);
  const known = await alreadyCollected(db, [{ artist: "HYUKOH", title: "Wi Ing Wi Ing", isrc: "kra401200001" }]);
  assert.equal(known.has(songKey("HYUKOH", "Wi Ing Wi Ing")), true);
});

test("a song we do not have is not mistaken for one we do", async () => {
  // 제목만 같고 가수가 다른 곡은 다른 곡이다 — 제목으로 후보를 추리므로 여기서 갈라야 한다.
  const db = open([["아이유", "밤편지", null]]);
  const known = await alreadyCollected(db, [{ artist: "다른 가수", title: "밤편지" }]);
  assert.equal(known.size, 0);
});

test("an empty basket asks the database nothing", async () => {
  const asked: string[] = [];
  const watching: BasketStore = {
    prepare: (sql: string) => {
      asked.push(sql);
      return { bind: () => ({ all: async () => ({ results: [] }) }) };
    },
  };
  assert.equal((await alreadyCollected(watching, [])).size, 0);
  assert.deepEqual(asked, []);
});

test("the server folds a song the same way the Collector does", async () => {
  // 두 쪽이 다르게 접으면 한쪽이 가졌다고 보는 곡을 다른 쪽은 새 곡으로 본다.
  const { songKey: collectorKey } = await import("../Collector/src/service.js");
  assert.equal(songKey("HYUKOH", "위잉위잉"), collectorKey("HYUKOH", "위잉위잉"));
  assert.equal(songKey("ＡＢＣ", "Ｄ"), collectorKey("ＡＢＣ", "Ｄ"));
});
