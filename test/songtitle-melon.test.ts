import assert from "node:assert/strict";
import test from "node:test";
import { melon } from "@mora/songtitle";

/**
 * 2026-09 의 통합검색 화면. 곡이 `<li>` 로 나오고 페이지 전체에 `<tr>` 이 거의 없다 — 예전처럼
 * 행마다 제목·가수를 읽던 길은 여기서 아무것도 못 찾는다. 곡 번호만 링크 안에 남아 있다.
 */
const SEARCH = `<html><body><ul class="list"><li>
<button onClick="melon.play.addPlayList('111');">담기</button>
<a href="javascript:melon.link.goSongDetail('111');" title="곡정보 보기"><span>영원은 그렇듯</span></a>
</li><li>
<a href="javascript:melon.link.goSongDetail('222');" title="곡정보 보기"><span>다른 곡</span></a>
</li></ul></body></html>`;

/** 상세 페이지. 제목 칸에는 "곡명" 라벨이 함께 들어 있다. */
function detail(title: string, lyric: string): string {
  return `<html><body>
    <div class="song_name"><strong class="none">곡명</strong>${title}</div>
    <div class="artist"><a href="#" title="리도어 - 페이지 이동">리도어</a></div>
    <div class="meta"><dl><dd>어떤 앨범</dd></dl></div>
    <div id="d_video_summary">${lyric}</div>
  </body></html>`;
}

/**
 * 첫 후보가 다른 곡이고 둘째가 찾는 곡인 검색 화면. 상세 페이지를 열어 제목을 확인하지 않으면
 * 첫 번째를 집어 엉뚱한 가사가 나간다 — 라틴어 가사 하나가 88곡에 붙었던 자리다.
 */
function serve(seen: string[], first = "다른 곡"): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    if (url.includes("/search/")) return new Response(SEARCH);
    if (url.includes("songId=111")) return new Response(detail(first, "첫째 줄<br>둘째 줄"));
    if (url.includes("songId=222")) return new Response(detail("영원은 그렇듯", "진짜 첫 줄<br>진짜 둘째 줄"));
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

const ctx = { keys: {}, timeoutMs: 5000, fetchImpl: undefined as unknown as typeof fetch };

test("melon finds the song even though the search page no longer has rows", async () => {
  const seen: string[] = [];
  const got = await melon.fetch({ title: "영원은 그렇듯", artist: "리도어" }, { ...ctx, fetchImpl: serve(seen, "영원은 그렇듯") });
  assert.equal(got?.trackId, "111");
  assert.equal(got?.title, "영원은 그렇듯");
  assert.equal(got?.artist, "리도어");
  assert.equal(got?.album, "어떤 앨범");
  assert.equal(got?.lyrics, "첫째 줄\n둘째 줄");
});

test("a candidate whose own page says another title is passed over", async () => {
  // 검색 결과 순서를 믿으면 안 된다. 상세 페이지의 제목이 질의와 맞아야 그 곡이다.
  const seen: string[] = [];
  const got = await melon.fetch({ title: "영원은 그렇듯", artist: "리도어" }, { ...ctx, fetchImpl: serve(seen) });
  assert.equal(got?.trackId, "222");
  assert.equal(got?.lyrics, "진짜 첫 줄\n진짜 둘째 줄");
  assert.ok(seen.some((one) => one.includes("songId=111")), "첫 후보도 열어 봤어야 한다");
});

test("no candidate with a matching title means this provider does not have it", async () => {
  const seen: string[] = [];
  const got = await melon.fetch({ title: "전혀 없는 곡", artist: "아무개" }, { ...ctx, fetchImpl: serve(seen) });
  assert.equal(got, null);
});

test("a track id given by the caller is trusted without checking the title", async () => {
  // 부르는 쪽이 이미 고른 곡이다. 그때 제목까지 따지면 표기가 다른 정상 곡을 잃는다.
  const seen: string[] = [];
  const got = await melon.fetch({ title: "아무 이름", trackId: "111" }, { ...ctx, fetchImpl: serve(seen, "다른 이름") });
  assert.equal(got?.trackId, "111");
  assert.ok(!seen.some((one) => one.includes("/search/")), "트랙 ID 가 있으면 검색하지 않는다");
});

test("only the first few candidates are opened", async () => {
  // 곡마다 요청이 한 번씩 더 드는 길이다. 검색 결과를 끝까지 열면 한 곡에 열 번을 묻게 된다.
  const many = `<html><body>${Array.from({ length: 9 }, (_, k) =>
    `<li><a href="javascript:melon.link.goSongDetail('${k + 1}');">곡</a></li>`).join("")}</body></html>`;
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    return new Response(url.includes("/search/") ? many : detail("딴 곡", "가사"));
  }) as typeof fetch;
  const got = await melon.fetch({ title: "영원은 그렇듯" }, { ...ctx, fetchImpl });
  assert.equal(got, null);
  assert.equal(seen.filter((one) => one.includes("songId=")).length, 3);
});
