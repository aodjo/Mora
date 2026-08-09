import assert from "node:assert/strict";
import test from "node:test";
import { decodeHtml, stripTags } from "../Collector/src/html.js";

/**
 * 실측한 것들만 모았다. 차트와 검색이 같은 사이트를 읽으면서 각자 이 일을 하고 있었고, 한쪽은
 * &nbsp; 를 몰라 "RESCENE&nbsp;(리센느)" 를 곡 정보로 저장했다.
 */
test("markup never reaches an artist or a title", () => {
  assert.equal(decodeHtml("RESCENE&nbsp;(리센느)"), "RESCENE (리센느)");
  assert.equal(decodeHtml("로제 (ROS&Eacute;)"), "로제 (ROSÉ)");
  assert.equal(decodeHtml("Beyonc&eacute;"), "Beyoncé");
  assert.equal(decodeHtml("Bj&ouml;rk"), "Björk");
  assert.equal(decodeHtml("Sigur R&oacute;s"), "Sigur Rós");
  assert.equal(decodeHtml("Weeeek &amp; Weeeek"), "Weeeek & Weeeek");
  assert.equal(decodeHtml("&#66;oy &#x41;da"), "Boy Ada");
});

test("an ampersand is resolved last, so encoded markup stays text", () => {
  // &amp;lt; 를 먼저 풀면 &lt; 가 되고, 다음 줄에서 태그가 된다.
  assert.equal(decodeHtml("&amp;lt;b&amp;gt;"), "&lt;b&gt;");
});

test("tags are removed without gluing the words together", () => {
  assert.equal(stripTags('<span class="icon">TITLE</span> Whiplash'), "TITLE Whiplash");
  assert.equal(stripTags("<b>좋은</b><i>날</i>"), "좋은 날");
});

test("an entity it does not know is left alone rather than mangled", () => {
  assert.equal(decodeHtml("A&frasl;B"), "A&frasl;B");
});
