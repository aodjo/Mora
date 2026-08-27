import assert from "node:assert/strict";
import { test } from "node:test";
import { SongTitleLyricsProvider, inferLyricsLanguage, isAnnotatedTranslation, sameArtist } from "../Collector/src/songtitle-provider.js";
import type { SongTitleRouter } from "../Collector/src/songtitle-provider.js";

test("SongTitle adapter preserves every non-empty provider result", async () => {
  const router: SongTitleRouter = {
    async fetchAll(query) {
      assert.deepEqual(query, { title: "노래", artist: "가수" });
      return {
        query,
        results: [
          { provider: "melon", lyrics: "그대로 둔 원문\n둘째 줄", url: "https://example.test/song/1" },
          { provider: "genie", lyrics: "English lyrics", trackId: "42" },
          { provider: "empty", lyrics: "  " },
        ],
        outcomes: [],
      };
    },
  };

  const result = await new SongTitleLyricsProvider(router).search({
    isrc: "KRA000000001",
    artist: "가수",
    title: "노래",
  });

  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    provider: "melon",
    provider_ref: "https://example.test/song/1",
    text: "그대로 둔 원문\n둘째 줄",
    language: "ko",
    fetched_at: result[0]?.fetched_at,
  });
  assert.equal(result[1]?.provider_ref, "genie:42");
  assert.equal(result[1]?.language, "en");
});

test("language inference is conservative for supported markets", () => {
  assert.equal(inferLyricsLanguage("안녕 hello"), "ko");
  assert.equal(inferLyricsLanguage("君の名前を呼ぶ"), "ja");
  assert.equal(inferLyricsLanguage("Hello world"), "en");
  assert.equal(inferLyricsLanguage("你好世界"), undefined);
});

test("a Japanese sheet with a Hangul reading guide is still Japanese", () => {
  // 멜론·벅스·FLO 는 일본 곡을 한국 독자에게 내보낼 때 줄마다 한글 발음을 달아 준다. 그래서
  // 일본어 시트에 한글이 섞이는 것은 정상인데, 한글을 먼저 2% 문턱으로 검사하던 규칙은 그것을
  // 한국어라 불렀다. 그러면 Whisper 가 일본어 노래를 한국어로 받아쓴다 — 米津玄師
  // 「IRIS OUT」이 그렇게 앵커 밀도 0.00, 실측 오차 4.8 초를 받았다. 언어만 바로잡자 0.50 과
  // 141ms 가 됐다.
  const guided = `${"君の人生の中に僕はいる ".repeat(30)}${"기미노 진세이 ".repeat(4)}`;
  assert.equal(inferLyricsLanguage(guided), "ja");
  // 한글이 더 많으면 그때는 한국어다. 발음 표기가 본문을 넘어서는 시트는 애초에 거부된다.
  assert.equal(inferLyricsLanguage(`${"사랑은 늘 도망가 ".repeat(30)}${"あの ".repeat(2)}`), "ko");
});

test("a name glossed in Hangul does not make an English song Korean", () => {
  // Genie heads its sheets with the song and the artist, the artist in Korean. Four characters
  // out of 2,600 sent Drake to the Korean recogniser.
  const drake = `Best I Ever Had - Drake (드레이크)\n${"baby you ma everything you all i eva wanted ".repeat(40)}`;
  assert.equal(inferLyricsLanguage(drake), "en");
  // A K-pop lyric that is mostly English is still Korean. This is the lowest Hangul share in the
  // collection, ATEEZ' "BAD" at 8%.
  assert.equal(inferLyricsLanguage(`${"I know you want it bad so bad ".repeat(11)}${"우리 둘만의 밤 ".repeat(3)}`), "ko");
});

test("a Japanese sheet republished with a Korean reading and translation is refused", () => {
  // Verbatim shape from Melon, Bugs and FLO: what is sung, how to say it, what it means. Only a
  // third of it is ever voiced.
  const annotated = [
    "駄目駄目駄目",
    "다메 다메 다메",
    "안 돼, 안 돼, 안 돼",
    "脳みその中から「やめろ馬鹿」と喚くモラリティ",
    "노-미소노 나카카라 「야메로 바카」토 와메쿠 모라리티",
    "머릿속에서 「그만둬, 바보」라고 외치는 Morality",
  ].join("\n");
  assert.equal(isAnnotatedTranslation(annotated), true);

  // Genie's copy of the same song, which is what should be timed.
  assert.equal(isAnnotatedTranslation("駄目駄目駄目\n脳みその中から「やめろ馬鹿」と喚くモラリティ\nダーリンベイビーダーリン"), false);
  // Neither market's own lyrics carry the other's script at all.
  assert.equal(isAnnotatedTranslation("따사로운 햇살 속에서\n종소리가 울려 퍼지네"), false);
  assert.equal(isAnnotatedTranslation("出来るだけ嘘は無いように\nどんな時も優しくあれるように"), false);
  assert.equal(isAnnotatedTranslation("Hello world"), false);
  assert.equal(isAnnotatedTranslation(""), false);
});

test("SongTitle adapter drops the notice a provider serves when it has no lyrics", async () => {
  // Verbatim from production: these landed as lyrics on 36, 35 and 7 recordings respectively.
  const router: SongTitleRouter = {
    async fetchAll(query) {
      return {
        query,
        results: [
          {
            provider: "bugs",
            lyrics: "가사 준비 중입니다.\n일반 가사 신청\n실시간 가사 신청\n벅스패널이 되면 가사를 등록하실 수 있습니다.",
          },
          { provider: "genie", lyrics: "가사 정보가 없습니다." },
          {
            provider: "bugs",
            lyrics: "청소년 보호법에 따라 19세 미만의 청소년이 이용할 수 없습니다.\n성인 인증 후 이용해 주세요. (연 1회)",
          },
          { provider: "flo", lyrics: "Swim, swim\nWater falling off your skin", title: "SWIM" },
        ],
        outcomes: [],
      };
    },
  };

  const result = await new SongTitleLyricsProvider(router).search({ artist: "BTS", title: "SWIM" });
  assert.deepEqual(
    result.map((item) => item.provider),
    ["flo"],
  );
});

test("a title alone does not name a song", () => {
  // Melon answered サザンオールスターズ' "FRIENDS" with Anne-Marie's. Same word, different
  // record — and the title check had nothing to disagree with.
  assert.equal(sameArtist("Anne-Marie", "サザンオールスターズ"), false);
  assert.equal(sameArtist("Ed Sheeran", "IU"), false);
  assert.equal(sameArtist("아이유", "태연"), false);
  // 괄호를 쪼개 본다고 서로 다른 사람이 같아지지는 않아야 한다.
  assert.equal(sameArtist("BIGBANG", "2NE1"), false);
  assert.equal(sameArtist("혁오 (HYUKOH)", "잔나비 (JANNABI)"), false);
});

test("the same artist written a dozen ways is still the same artist", () => {
  assert.equal(sameArtist("사잔 올 스타즈", "사잔 올 스타즈"), true);
  assert.equal(sameArtist("BTS (방탄소년단)", "BTS"), true);
  assert.equal(sameArtist("aespa", "aespa 에스파"), true);
  assert.equal(sameArtist("Anne-Marie", "anne marie"), true);
  // 합작 크레딧은 이름을 이어 붙인다. 그중 하나만 맞으면 그 사람의 곡이다.
  assert.equal(sameArtist("Anne-Marie & Rudimental", "Anne-Marie"), true);
  assert.equal(sameArtist("Ella Langley", "Ella Langley & Morgan Wallen"), true);
  assert.equal(sameArtist("Drake feat. 21 Savage", "Drake"), true);
  assert.equal(sameArtist("HUNTR/X, EJAE, AUDREY NUNA", "HUNTR/X"), true);
  // 한 이름을 두 문자로 함께 적을 때 어느 쪽을 앞에 두느냐는 서비스마다 다르다. 붙여 놓고
  // 서로를 품는지 보는 방식은 순서가 뒤집히면 막혔다 — 이 검사가 도리어 멀쩡한 가사를
  // 버리게 된다. YouTube 채널 판정에서 같은 모양의 버그를 고친 것과 짝이다.
  assert.equal(sameArtist("혁오 (HYUKOH)", "HYUKOH(혁오)"), true);
  assert.equal(sameArtist("HYUKOH(혁오)", "혁오 (HYUKOH)"), true);
  assert.equal(sameArtist("아이유 (IU)", "IU (아이유)"), true);
  assert.equal(sameArtist("방탄소년단 (BTS)", "BTS (방탄소년단)"), true);
  assert.equal(sameArtist("키키", "KiiiKiii (키키)"), true);
  // 크레딧을 안 적는 공급자는 제목 검사에 맡긴다 — 막으면 그 공급자가 통째로 사라진다.
  assert.equal(sameArtist(undefined, "IU"), true);
  assert.equal(sameArtist("", "IU"), true);
});

test("SongTitle adapter drops lyrics a provider matched to a different song", async () => {
  // Melon answered one Latin lyric for 88 different HOYO-MiX recordings.
  const router: SongTitleRouter = {
    async fetchAll(query) {
      return {
        query,
        results: [
          { provider: "melon", lyrics: "A luna, cara cantica\nNe me in atra dedas", title: "Nocturne of Chains" },
          { provider: "genius", lyrics: "진짜 가사\n둘째 줄", title: "笼中遗事 (Bonus Track)" },
        ],
        outcomes: [],
      };
    },
  };

  const result = await new SongTitleLyricsProvider(router).search({ artist: "HOYO-MiX", title: "笼中遗事" });
  assert.deepEqual(
    result.map((item) => item.provider),
    ["genius"],
  );
});

test("a song whose own title reads like a notice is still collected", async () => {
  const router: SongTitleRouter = {
    async fetchAll(query) {
      return {
        query,
        results: [{ provider: "genius", lyrics: "Live forever\nI wanna live forever", title: "Live Forever" }],
        outcomes: [],
      };
    },
  };
  const result = await new SongTitleLyricsProvider(router).search({ artist: "Oasis", title: "Live Forever" });
  assert.equal(result.length, 1);
});
