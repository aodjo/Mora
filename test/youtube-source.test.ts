import assert from "node:assert/strict";
import { test } from "node:test";
import { canAutoSelect } from "../Collector/src/service.js";
import type { RecordingSeed } from "../Collector/src/types.js";
import { isArtistChannel, isDifferentRecording, searchYoutubeMusic, type YtEntry } from "../Collector/src/youtube.js";

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

test("a name written in two scripts is the same name whichever half is used", () => {
  // 카탈로그는 "혁오 (HYUKOH)" 라 적고 채널은 "HYUKOH" 하나만 쓴다. 모든 낱말이 채널에
  // 있기를 요구하던 판정은 그 채널을 남의 것으로 보았고, 위잉위잉의 공식 오디오가 비공식으로
  // 밀려나 길이가 0.0초 차이인데도 검수로 갔다.
  assert.equal(isArtistChannel("HYUKOH", "혁오 (HYUKOH)"), true);
  assert.equal(isArtistChannel("혁오", "혁오 (HYUKOH)"), true);
  assert.equal(isArtistChannel("HYUKOH - Topic", "혁오 (HYUKOH)"), true);
  assert.equal(isArtistChannel("이지금 [IU Official]", "아이유 (IU)"), true);

  // 이름을 부르지 않은 채널은 여전히 남의 것이다.
  assert.equal(isArtistChannel("웅키", "혁오 (HYUKOH)"), false);
  assert.equal(isArtistChannel("j", "혁오 (HYUKOH)"), false);
  assert.equal(isArtistChannel("JXS_BP Official", "BTS"), false);
  assert.equal(isArtistChannel("7clouds K-pop", "aespa"), false);
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

test("the backing track is dropped however the label abbreviated it", () => {
  // 10CM's own channel posted this one, so every other signal said take it. Nothing is sung on
  // it: the separated voice came out 61 dB under the mix and not one word could be anchored.
  assert.equal(isDifferentRecording("To Reach You (Inst.) (너에게 닿기를 (Inst.))", "너에게 닿기를"), true);
  assert.equal(isDifferentRecording("aespa 에스파 'Whiplash' (Inst)", "Whiplash"), true);
  assert.equal(isDifferentRecording("IU '밤편지' Inst Ver.", "밤편지"), true);
  assert.equal(isDifferentRecording("YOASOBI「アイドル」Off Vocal", "アイドル"), true);
  assert.equal(isDifferentRecording("Red Velvet - Hawaii (MR)", "Hawaii"), true);
  assert.equal(isDifferentRecording("레드벨벳 Hawaii MR 제거", "Hawaii"), true);
  assert.equal(isDifferentRecording("아이유 밤편지 인스트", "밤편지"), true);
  assert.equal(isDifferentRecording("NewJeans - Supernatural (Backing Track)", "Supernatural"), true);
});

test("a song is not disqualified by the words in its own title", () => {
  assert.equal(isDifferentRecording("Oasis - Live Forever (Official Video)", "Live Forever"), false);
  assert.equal(isDifferentRecording("Bruce Springsteen - Cover Me", "Cover Me"), false);
  assert.equal(isDifferentRecording("Piano Man - Billy Joel", "Piano Man"), false);
  assert.equal(isDifferentRecording("Red Velvet 레드벨벳 'Hawaii' Official Audio", "Hawaii"), false);
  assert.equal(isDifferentRecording("【Ado】ギラギラ (Gira Gira)", "ギラギラ"), false);
  // "inst" is short enough to collide. It may not fire inside a longer word, and the two-letter
  // "mr" only counts parenthesized or in front of a version word — otherwise every Mr. in an
  // artist's name would disqualify the song underneath it.
  assert.equal(isDifferentRecording("Owl City - Fireflies (Instant Crush Edit)", "Fireflies"), false);
  assert.equal(isDifferentRecording("Mr. Kitty - After Dark", "After Dark"), false);
  assert.equal(isDifferentRecording("SUPER JUNIOR 슈퍼주니어 'Mr. Simple'", "Mr. Simple"), false);
});

test("an hour of the song on repeat is not the song", () => {
  // The old check read /\d+\s*(?:시간|hours?|hr)\b/ and could not fire on a Korean title at
  // all: \b after 간 asks for an ASCII word character, so every 시간 upload went through.
  assert.equal(isDifferentRecording("아이유 (IU) - 밤편지 1시간", "밤편지"), true);
  assert.equal(isDifferentRecording("아이유 (IU) - 밤편지 1시간 연속듣기", "밤편지"), true);
  assert.equal(isDifferentRecording("Ado - 唱 1時間耐久", "唱"), true);
  assert.equal(isDifferentRecording("NewJeans - Supernatural 1 hour loop", "Supernatural"), true);
  assert.equal(isDifferentRecording("Red Velvet - Hawaii (10 hours)", "Hawaii"), true);
  // Edits that are longer than the master by construction, and the compilations.
  assert.equal(isDifferentRecording("aespa 에스파 'Whiplash' (Extended Mix)", "Whiplash"), true);
  assert.equal(isDifferentRecording("Red Velvet - Hawaii 반복재생", "Hawaii"), true);
  assert.equal(isDifferentRecording("NewJeans - Ditto 메들리", "Ditto"), true);
  assert.equal(isDifferentRecording("IU - Love wins all 슬로우드", "Love wins all"), true);
});

test("a loop word in the song's own name does not disqualify the song", () => {
  // Judged on what the uploader added, like every other disqualifier, so a song that counts
  // hours or is called Loop keeps its place.
  assert.equal(isDifferentRecording("선미 (SUNMI) - 24시간이 모자라", "24시간이 모자라"), false);
  assert.equal(isDifferentRecording("Rokudenashi - Loop", "Loop"), false);
  assert.equal(isDifferentRecording("Ado - 唱", "唱"), false);
  // "Extended Play" is an EP. It says nothing about which cut of the audio this is.
  assert.equal(isDifferentRecording("beabadoobee - Cologne (Our Extended Play)", "Cologne"), false);
});

const WHIPLASH: RecordingSeed = {
  artist: "aespa",
  title: "Whiplash",
  duration_ms: 184_000,
  popularity: 1,
  freshness: 0,
  market: "KR",
};

/**
 * The shape the product owner keeps hitting: the artist's own channel holds the music video,
 * which runs half a minute long, and the only upload that runs to the master is a reupload.
 */
const WHIPLASH_RESULTS: YtEntry[] = [
  { id: "mv111111111", title: "aespa 에스파 'Whiplash' MV", duration: 216, channel: "aespa", uploader: "aespa" },
  {
    id: "reup2222222",
    title: "aespa (에스파) - Whiplash [Official Audio]",
    duration: 184,
    channel: "K-Pop Vibes",
    uploader: "K-Pop Vibes",
  },
];

const found = async (seed: RecordingSeed, entries: YtEntry[]) => searchYoutubeMusic(seed, async () => entries);

test("an unofficial upload that runs to the master outranks the artist's own music video", async () => {
  const sources = await found(WHIPLASH, WHIPLASH_RESULTS);
  assert.equal(sources[0]?.video_id, "reup2222222", "길이가 맞는 쪽이 먼저다");
  assert.equal(sources[0]?.official, false);
  assert.equal(sources[1]?.video_id, "mv111111111", "뮤직비디오는 떨어뜨리지 않고 뒤로 미룬다");
  // Ownership used to sort above the score outright, which put the 3:36 video first.
  assert.ok((sources[0]?.score ?? 0) > (sources[1]?.score ?? 1));
});

test("a length that agrees with the catalogue is enough to select an unofficial upload", async () => {
  // The old rule needed 0.85, and a flat search hands back the whole video title, so titleScore
  // is 0.8 for almost every real candidate and nothing but an exact-title official upload could
  // reach it. Length agreement is what says this is that recording.
  const catalogued = await found({ ...WHIPLASH, catalogue_duration_ms: 184_000 }, WHIPLASH_RESULTS);
  assert.equal(canAutoSelect(catalogued[0], 184_000), true);
  assert.equal(catalogued[0]?.catalogue_drift_ms, 0);

  // Most songs never reach LyricFind — MusicBrainz answers with the ISRC and the length
  // together — so there is no catalogue_drift_ms and the length on the recording is all there
  // is. It is still the length we publish, and it still decides.
  const plain = await found(WHIPLASH, WHIPLASH_RESULTS);
  assert.equal(plain[0]?.catalogue_drift_ms, undefined);
  assert.equal(canAutoSelect(plain[0], 184_000), true);

  // The music video is second choice and stays in review whoever posted it.
  assert.equal(canAutoSelect(plain[1], 184_000), false);
});

test("the only upload there is still reaches review rather than being dropped", async () => {
  // A song with nothing but its music video must not become "음원 없음": that answer is
  // remembered, and the song never comes back.
  const sources = await found(WHIPLASH, [WHIPLASH_RESULTS[0]!]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.official, true);
  assert.equal(canAutoSelect(sources[0], 184_000), false, "길이가 32초 어긋난다");
});

test("a shortlist is not a place for whatever the search returned", async () => {
  const noise: YtEntry[] = [
    // Names neither the song nor the artist. A length that happens to agree cannot make it this
    // song, and letting it through would hand the recording a duration from the wrong track.
    { id: "other111111", title: "TWICE - Strategy (feat. Megan Thee Stallion)", duration: 184, channel: "TWICE" },
    // Shorts and edits carry the right title over a fragment; compilations carry it over far too
    // much. Both bounds are unchanged.
    { id: "short222222", title: "aespa 에스파 'Whiplash' #shorts", duration: 45, channel: "aespa" },
    { id: "compil33333", title: "aespa 에스파 'Whiplash' + b-sides", duration: 620, channel: "aespa" },
  ];
  assert.deepEqual(await found(WHIPLASH, noise), []);
});
