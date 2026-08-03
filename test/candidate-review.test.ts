import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewLyrics } from "../Server/src/admin/candidate-review.js";

test("candidate review exposes lyric words, lines, and the strongest speaker assignment",()=>{
  const review=buildReviewLyrics("Hello world\n다시 만나", "ko", [[0,1,.4],[0,2,.8],[2,0,.7]]);
  assert.deepEqual(review.lines.map(line=>line.text),["Hello world","다시 만나"]);
  assert.deepEqual(review.tokens.map(token=>token.text),["Hello","world","다시","만나"]);
  assert.deepEqual(review.tokens.map(token=>token.speaker_id),[2,null,0,null]);
});
