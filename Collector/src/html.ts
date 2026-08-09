/**
 * Turning a page's markup back into the text it stands for.
 *
 * The chart and the search read the same sites, and each had grown its own version of this —
 * one of which did not know &nbsp;, so "RESCENE (리센느)" was collected as
 * "RESCENE&nbsp;(리센느)": no catalogue matched it and the console showed the markup. One
 * place to fix means one place that can be wrong.
 */
export function decodeHtml(value: string): string {
  return (
    value
      // A non-breaking space is a space; leaving it in is how markup reaches a song title.
      .replace(/&nbsp;|&#0*160;|&#x0*a0;/giu, " ")
      .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/giu, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
      // 이름 있는 라틴 문자들 — 멜론이 ROSÉ 를 &Eacute; 로 쓴다.
      .replace(/&([A-Za-z])(acute|grave|circ|uml|tilde|ring|cedil|slash);/gu, (whole, letter: string, mark: string) => {
        const accents: Record<string, string> = {
          acute: "\u0301",
          grave: "\u0300",
          circ: "\u0302",
          uml: "\u0308",
          tilde: "\u0303",
          ring: "\u030A",
          cedil: "\u0327",
        };
        const accent = accents[mark];
        if (accent === undefined) return mark === "slash" ? (letter === letter.toUpperCase() ? "Ø" : "ø") : whole;
        return (letter + accent).normalize("NFC");
      })
      .replace(/&szlig;/gu, "ß")
      .replace(/&AElig;/gu, "Æ")
      .replace(/&aelig;/gu, "æ")
      .replace(/&lt;/gu, "<")
      .replace(/&gt;/gu, ">")
      .replace(/&quot;/gu, '"')
      .replace(/&apos;/gu, "'")
      // Last, or a doubly encoded &amp;lt; would turn into a tag.
      .replace(/&amp;/gu, "&")
      .replace(/\s+/gu, " ")
      .trim()
  );
}

/** The text of a fragment that may still carry tags, as a person would read it. */
export function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/gu, " "));
}
