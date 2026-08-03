import assert from "node:assert/strict";
import test from "node:test";
import { youtubeVideoId } from "../Server/src/admin/source-review.js";

test("source review accepts YouTube Music and short links",()=>{
  assert.equal(youtubeVideoId("https://music.youtube.com/watch?v=qQU5Fjqkg0c"),"qQU5Fjqkg0c");
  assert.equal(youtubeVideoId("https://youtu.be/qQU5Fjqkg0c"),"qQU5Fjqkg0c");
});

test("source review rejects non-YouTube and insecure URLs",()=>{
  assert.throws(()=>youtubeVideoId("https://example.com/watch?v=qQU5Fjqkg0c"),/INVALID_REQUEST/u);
  assert.throws(()=>youtubeVideoId("http://music.youtube.com/watch?v=qQU5Fjqkg0c"),/INVALID_REQUEST/u);
});
