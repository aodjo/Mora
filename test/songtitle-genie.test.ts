import assert from "node:assert/strict";
import test from "node:test";
import { genie } from "../packages/songtitle/src/providers/genie.js";

const SEARCH = `<table><tbody><tr class="list" songid="98798057">
<td><a href="#" class="title ellipsis" title="살인 아니고 사랑인데요??"><span class="icon">19금</span>살인 아니고 사랑인데요??</a>
<a href="#" class="artist ellipsis">Ruru (루루)</a>
<a href="#" class="albumtitle ellipsis">앨범</a></td></tr></tbody></table>`;

/** 로그인하지 않은 사람이 성인 등급 곡의 상세 페이지에서 받는 것. */
const GATED = `<html><body><div id="pLyrics"><p class="lyrics">
로그인 후 가사보기 기능이 제공 됩니다. 로그인 바로가기
</p></div></body></html>`;

const OPENED = `<html><body><div id="pLyrics"><p class="lyrics">
있잖아 사실 난 말이야<br>너를 내가 혼자 가지고 싶어<br>칼로 찌르는 상상을 하곤 해
</p></div></body></html>`;

/**
 * 실측: 이 곡의 상세 페이지가 기본 UA 로는 12만 바이트에 가사가 없고, 크롤러 UA 로는
 * 17만 바이트에 가사 전문이 온다. 성인 등급 곡의 가사는 사람에게는 로그인을 요구하지만
 * 검색 색인을 위해 크롤러에게는 열려 있다.
 */
function serve(seen: Array<{ url: string; ua: string }>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const ua = String(new Headers(init?.headers).get("user-agent") ?? "");
    seen.push({ url, ua });
    if (url.includes("/search/")) return new Response(SEARCH);
    if (url.includes("get_msl.asp")) return new Response("NOT FOUND LYRICS");
    return new Response(/Googlebot/u.test(ua) ? OPENED : GATED);
  }) as typeof fetch;
}

test("an age-rated song's lyrics are read as the crawler sees them", async () => {
  const seen: Array<{ url: string; ua: string }> = [];
  const found = await genie.fetch(
    { artist: "Ruru (루루)", title: "살인 아니고 사랑인데요??" },
    { timeoutMs: 5000, fetchImpl: serve(seen), keys: {} },
  );
  assert.ok(found !== null, "가사를 찾아야 한다");
  assert.match(found.lyrics, /칼로 찌르는 상상을 하곤 해/u);
  assert.doesNotMatch(found.lyrics, /로그인/u, "로그인 안내가 가사로 저장되면 안 된다");

  const search = seen.find((call) => call.url.includes("/search/"));
  const detail = seen.find((call) => call.url.includes("/detail/"));
  assert.doesNotMatch(search?.ua ?? "", /Googlebot/u, "검색은 크롤러에게 결과를 주지 않는다");
  assert.match(detail?.ua ?? "", /Googlebot/u, "가사만 크롤러로 묻는다");
});
