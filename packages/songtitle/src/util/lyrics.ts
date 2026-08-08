import type { LyricLine } from "../types.js";

/** HTML 조각을 평문 가사로 변환 (<br>→줄바꿈, 태그/엔티티 정리) */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** "[mm:ss.xx] 가사" 형태의 LRC 문자열을 타임 싱크 라인으로 파싱 */
export function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const line of lrc.split(/\r?\n/)) {
    const tags = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (tags.length === 0) continue;
    const text = line.replace(/\[[^\]]*\]/g, "").trim();
    for (const t of tags) {
      const min = Number(t[1]);
      const sec = Number(t[2]);
      const frac = t[3] ? Number((t[3] + "00").slice(0, 3)) : 0;
      out.push({ timeMs: (min * 60 + sec) * 1000 + frac, text });
    }
  }
  return out.sort((a, b) => a.timeMs - b.timeMs);
}

/** ms 오프셋을 [mm:ss.xx] 형태로 */
export function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/** 비교/매칭용 정규화 */
export function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** 평문/싱크 중 존재하는 것으로 최종 평문 가사를 만든다 */
export function plainFrom(plain: string | undefined, synced: LyricLine[] | undefined): string {
  const p = (plain ?? "").trim();
  if (p) return p;
  if (synced && synced.length)
    return synced
      .map((l) => l.text)
      .join("\n")
      .trim();
  return "";
}
