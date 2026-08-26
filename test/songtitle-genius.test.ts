import assert from "node:assert/strict";
import { test } from "node:test";
import { describeAvailability, genius, lyricfind, shazam, melon } from "@mora/songtitle";
import type { ProviderContext } from "@mora/songtitle";

/**
 * 이 파일은 소스 경로(../packages/songtitle/src/...)가 아니라 패키지 엔트리
 * `@mora/songtitle`에서 가져온다. 소스로 직접 들어가면 tsc가 그 파일들을
 * dist/packages/songtitle/src/ 로 같이 뱉는데, 거기서는 cheerio가 해석되지 않는다
 * (cheerio는 packages/songtitle/node_modules 에만 있고 pnpm이 호이스트하지 않는다).
 * 패키지 엔트리로 가면 packages/songtitle/dist 가 로드되고 cheerio도 제자리에서 풀린다.
 */

/** 곡 페이지 HTML 한 장. 가사 자리에는 실제 가사가 아니라 표식만 넣는다. */
function songPage(pageTitle: string, body = "LINE ONE\nLINE TWO"): string {
  return `<!doctype html><html><head><title>${pageTitle} | Genius Lyrics</title></head>
    <body><div data-lyrics-container="true">${body.replace(/\n/g, "<br/>")}</div></body></html>`;
}

/**
 * URL → 응답. `redirectTo`를 주면 Response.url을 그 값으로 세워 리다이렉트를 흉내낸다
 * (Response 생성자로는 url을 못 채운다).
 */
function fakeFetch(routes: Record<string, { body: string; status?: number; redirectTo?: string }>): {
  impl: typeof fetch;
  seen: string[];
} {
  const seen: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    const hit = routes[url];
    if (!hit) return new Response("not found", { status: 404 });
    const res = new Response(hit.body, { status: hit.status ?? 200 });
    Object.defineProperty(res, "url", { value: hit.redirectTo ?? url });
    return res;
  }) as typeof fetch;
  return { impl, seen };
}

function ctx(impl: typeof fetch): ProviderContext {
  return { keys: {}, timeoutMs: 5_000, fetchImpl: impl };
}

const WHAT = "https://genius.com/Billie-eilish-what-was-i-made-for-lyrics";

test("genius는 토큰이 없어도 곡 URL을 조립해 가사를 가져온다", async () => {
  const { impl, seen } = fakeFetch({ [WHAT]: { body: songPage("Billie Eilish – What Was I Made For? Lyrics") } });
  const got = await genius.fetch({ title: "What Was I Made For?", artist: "Billie Eilish" }, ctx(impl));
  assert.equal(got?.provider, "genius");
  assert.equal(got?.artist, "Billie Eilish");
  assert.match(got?.lyrics ?? "", /LINE ONE/u);
  // 검색 경로는 robots.txt가 막아둔 곳이다 — 곡 페이지 한 장만 읽어야 한다.
  assert.deepEqual(seen, [WHAT]);
});

test("genius 슬러그 폴백은 어퍼스트로피와 feat 꼬리를 슬러그에서 떼어낸다", async () => {
  const url = "https://genius.com/Cody-johnson-til-you-cant-lyrics";
  const { impl } = fakeFetch({ [url]: { body: songPage("Cody Johnson – 'Til You Can't Lyrics") } });
  assert.ok(await genius.fetch({ title: "'Til You Can't", artist: "Cody Johnson" }, ctx(impl)));

  const feat = "https://genius.com/Post-malone-i-had-some-help-lyrics";
  const two = fakeFetch({ [feat]: { body: songPage("Post Malone – I Had Some Help Lyrics") } });
  assert.ok(await genius.fetch({ title: "I Had Some Help (feat. Morgan Wallen)", artist: "Post Malone" }, ctx(two.impl)));
});

/**
 * 실제 사례: `Lady-gaga-die-with-a-smile-lyrics`는 301로 싱할라어 번역본 페이지로 넘어간다.
 * 조립한 URL은 "그 곡"이라는 보장이 없으므로 받은 페이지를 반드시 확인해야 한다.
 */
test("genius 슬러그 폴백은 번역본 페이지로 넘어가면 버린다", async () => {
  const asked = "https://genius.com/Lady-gaga-die-with-a-smile-lyrics";
  const { impl } = fakeFetch({
    [asked]: {
      body: songPage("Die With A Smile (සිංහල පරිවර්තන) – Lady Gaga & Bruno Mars Lyrics"),
      redirectTo: "https://genius.com/Genius-sinhala-translations-lady-gaga-and-bruno-mars-die-with-a-smile-lyrics",
    },
  });
  assert.equal(await genius.fetch({ title: "Die With A Smile", artist: "Lady Gaga" }, ctx(impl)), null);
});

test("genius 슬러그 폴백은 다른 곡·다른 아티스트가 오면 버린다", async () => {
  const wrongTitle = fakeFetch({ [WHAT]: { body: songPage("Billie Eilish – Bad Guy Lyrics") } });
  assert.equal(await genius.fetch({ title: "What Was I Made For?", artist: "Billie Eilish" }, ctx(wrongTitle.impl)), null);

  const url = "https://genius.com/Queen-bohemian-rhapsody-lyrics";
  const wrongArtist = fakeFetch({ [url]: { body: songPage("Panic! At The Disco – Bohemian Rhapsody Lyrics") } });
  assert.equal(await genius.fetch({ title: "Bohemian Rhapsody", artist: "Queen" }, ctx(wrongArtist.impl)), null);
});

/**
 * Genius는 일본어·한국어 곡의 슬러그를 로마자로 적는다("一途" → ichizu). 원제로는
 * 절대 맞출 수 없으니 요청 자체를 하지 않는다 — 그쪽은 토큰이 있어야 닿는다.
 */
test("genius 슬러그 폴백은 CJK 제목이면 요청도 하지 않는다", async () => {
  for (const [artist, title] of [
    ["King Gnu", "一途"],
    ["Mrs. GREEN APPLE", "ライラック"],
    ["아이유", "밤편지"],
  ]) {
    const { impl, seen } = fakeFetch({});
    assert.equal(await genius.fetch({ title: title!, artist: artist! }, ctx(impl)), null);
    assert.deepEqual(seen, [], `${title}로 요청을 보내면 안 된다`);
  }
});

test("가용성 보고가 죽은 프로바이더를 이유와 함께 드러낸다", () => {
  const dead = describeAvailability([melon, genius, shazam, lyricfind], {}, false);
  assert.deepEqual(
    dead.map((a) => [a.provider, a.live]),
    [
      ["melon", true],
      ["genius", true], // 토큰이 없어도 슬러그 폴백이 있다
      ["shazam", false],
      ["lyricfind", false],
    ],
  );
  assert.match(dead.find((a) => a.provider === "lyricfind")?.reason ?? "", /LYRICFIND_API_KEY/u);
  assert.match(dead.find((a) => a.provider === "shazam")?.reason ?? "", /SONGTITLE_BROWSER/u);

  // 브라우저를 켜면 shazam은 살아나고, lyricfind는 키가 없으면 여전히 죽어 있다.
  const withBrowser = describeAvailability([shazam, lyricfind], {}, true);
  assert.equal(withBrowser.find((a) => a.provider === "shazam")?.live, true);
  assert.equal(withBrowser.find((a) => a.provider === "lyricfind")?.live, false);

  // 키를 주면 lyricfind도 살아난다.
  assert.equal(describeAvailability([lyricfind], { LYRICFIND_API_KEY: "k" }, false)[0]?.live, true);
});
