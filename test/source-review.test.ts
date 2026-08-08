import assert from "node:assert/strict";
import test from "node:test";
import { normalizeIsrc, resolveLyricLanguage, youtubeVideoId } from "../Server/src/admin/source-review.js";

test("source review accepts YouTube Music and short links", () => {
  assert.equal(youtubeVideoId("https://music.youtube.com/watch?v=qQU5Fjqkg0c"), "qQU5Fjqkg0c");
  assert.equal(youtubeVideoId("https://youtu.be/qQU5Fjqkg0c"), "qQU5Fjqkg0c");
});

test("source review rejects non-YouTube and insecure URLs", () => {
  assert.throws(() => youtubeVideoId("https://example.com/watch?v=qQU5Fjqkg0c"), /INVALID_REQUEST/u);
  assert.throws(() => youtubeVideoId("http://music.youtube.com/watch?v=qQU5Fjqkg0c"), /INVALID_REQUEST/u);
});

test("source review validates ISRC and resolves lyric language", () => {
  assert.equal(normalizeIsrc("kr-a30-26-00330"), "KRA302600330");
  assert.throws(() => normalizeIsrc("missing"), /INVALID_REQUEST/u);
  assert.equal(resolveLyricLanguage("auto", "오늘도 노래해"), "ko");
  assert.equal(resolveLyricLanguage("auto", "君と歌う"), "ja");
  assert.equal(resolveLyricLanguage("auto", "sing with me"), "en");
});
