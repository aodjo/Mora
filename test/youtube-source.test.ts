import assert from "node:assert/strict";
import { test } from "node:test";
import { isArtistChannel, isDifferentRecording } from "../Collector/src/youtube.js";

test("official means the artist's own channel, not the word in a channel name", () => {
  // Real artist channels, including the Topic channel a label feeds automatically.
  assert.equal(isArtistChannel("Red Velvet", "Red Velvet"), true);
  assert.equal(isArtistChannel("aespa", "aespa"), true);
  assert.equal(isArtistChannel("Ado", "Ado"), true);
  assert.equal(isArtistChannel("Official ARTMS", "ARTMS"), true);
  assert.equal(isArtistChannel("이지금 [IU Official]", "IU"), true);
  assert.equal(isArtistChannel("Oasis - Topic", "Oasis"), true);

  // Reuploaders and cover channels that the old /topic|official/ test rubber-stamped.
  assert.equal(isArtistChannel("JXS_BP Official", "BTS"), false);
  assert.equal(isArtistChannel("NORISTRY Official", "Ado"), false);
  assert.equal(isArtistChannel("Philippe Briand - Topic", "HOYO-MiX"), false);
  assert.equal(isArtistChannel("Jaeguchi", "NewJeans"), false);
  assert.equal(isArtistChannel("7clouds K-pop", "aespa"), false);
  assert.equal(isArtistChannel("", "IU"), false);
});

test("uploads that are not the released recording are dropped", () => {
  // Every one of these outranked the real audio in a live search.
  assert.equal(isDifferentRecording("ギラギラ - Ado / covered NORISTRY", "ギラギラ"), true);
  assert.equal(isDifferentRecording("【歌ってみた】ギラギラ / Ado covered by 猫", "ギラギラ"), true);
  assert.equal(isDifferentRecording("ギラギラ / Ado カラオケ ガイドメロディーあり", "ギラギラ"), true);
  assert.equal(isDifferentRecording("my bloody valentine - only shallow (+0.5st)", "Only Shallow"), true);
  assert.equal(isDifferentRecording("My Bloody Valentine - Only Shallow (Vinyl Rip) HQ", "Only Shallow"), true);
  assert.equal(isDifferentRecording("aespa 에스파 'Whiplash (English Version)'", "Whiplash"), true);
  assert.equal(isDifferentRecording("NewJeans 'Supernatural' Dance Practice", "Supernatural"), true);
  assert.equal(isDifferentRecording("IU 'Love wins all' Live Clip (2024 TOUR)", "Love wins all"), true);
  assert.equal(isDifferentRecording("Red Velvet - Hawaii (Slowed + Reverb)", "Hawaii"), true);
});

test("a song is not disqualified by the words in its own title", () => {
  assert.equal(isDifferentRecording("Oasis - Live Forever (Official Video)", "Live Forever"), false);
  assert.equal(isDifferentRecording("Bruce Springsteen - Cover Me", "Cover Me"), false);
  assert.equal(isDifferentRecording("Piano Man - Billy Joel", "Piano Man"), false);
  assert.equal(isDifferentRecording("Red Velvet 레드벨벳 'Hawaii' Official Audio", "Hawaii"), false);
  assert.equal(isDifferentRecording("【Ado】ギラギラ (Gira Gira)", "ギラギラ"), false);
});
