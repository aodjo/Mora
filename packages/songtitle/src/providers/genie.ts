import * as cheerio from "cheerio";
import type { LyricLine, Provider } from "../types.js";
import { getText, type HttpOptions } from "../http.js";
import { htmlToPlainText, plainFrom } from "../util/lyrics.js";
import { pickTrack } from "../util/match.js";

const BASE = "https://www.genie.co.kr";

interface GenieRow {
  songId: string;
  title: string;
  artist: string;
  album?: string | undefined;
}

/**
 * Genie — 검색 결과 행에서 질의와 제목이 일치하는 곡을 고르고, get_msl.asp(JSONP)에서
 * 타임 싱크 가사를 받는다. JSONP 실패 시 상세 페이지 스크랩으로 폴백.
 *
 * 첫 행을 검증 없이 집던 시절 "The Wolf Is Coming HOYO-MiX" 질의가 Tyler, The Creator의
 * "Window"를 반환했고, 질의 제목을 그대로 되돌려줘 하류 검증까지 통과했다. 이제 실제
 * 매칭된 행의 제목·아티스트를 보고한다.
 */
export const genie: Provider = {
  name: "genie",
  async fetch(query, ctx) {
    const opts: HttpOptions = {
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      fetchImpl: ctx.fetchImpl,
      headers: { Referer: `${BASE}/` },
    };
    const q = [query.title, query.artist].filter(Boolean).join(" ");

    let songId = query.trackId;
    let matched: GenieRow | undefined;
    if (!songId) {
      const html = await getText(`${BASE}/search/searchMain?query=${encodeURIComponent(q)}`, opts);
      matched = pickTrack(parseSearchRows(html), query, (row) => row);
      songId = matched?.songId;
    }
    if (!songId) return null;

    let synced: LyricLine[] | undefined;
    let lyrics = "";

    try {
      const jsonp = await getText(`https://dn.genie.co.kr/app/purchase/get_msl.asp?path=a&songid=${songId}`, opts);
      synced = parseGenieMsl(jsonp);
      if (isTitleHeader(synced[0]?.text, matched)) synced = synced.slice(1);
      lyrics = synced.map((l) => l.text).join("\n");
    } catch {
      /* JSONP 실패 → 아래 폴백 */
    }

    const detailUrl = `${BASE}/detail/songInfo?xgnm=${songId}`;
    if (!lyrics) {
      const scraped = htmlToPlainText($detail(await getText(detailUrl, opts))).split("\n");
      if (isTitleHeader(scraped[0], matched)) scraped.shift();
      lyrics = scraped.join("\n").trim();
    }
    if (!lyrics) return null;

    return {
      provider: "genie",
      title: matched?.title ?? query.title,
      artist: matched?.artist ?? query.artist,
      album: matched?.album,
      lyrics: plainFrom(lyrics, synced),
      synced: synced && synced.length ? synced : undefined,
      url: detailUrl,
      trackId: songId,
    };
  },
};

function $detail(html: string): string {
  const $ = cheerio.load(html);
  return $("#pLyrics p").html() ?? $(".lyrics").html() ?? "";
}

function compact(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Genie는 곡에 따라 가사 맨 앞에 "Half The World Away - Oasis" 같은 제목 줄을 넣는다.
 * 싱크 가사에서는 0ms에 붙어 있어, 그대로 두면 정렬이 통째로 한 줄씩 밀린다.
 * 제목(+아티스트)과 정확히 같을 때만 버린다 — "Swim, swim"처럼 제목으로 시작하는
 * 진짜 첫 소절은 남겨야 하기 때문이다.
 */
function isTitleHeader(line: string | undefined, matched: GenieRow | undefined): boolean {
  if (line === undefined || matched === undefined) return false;
  const first = compact(line);
  if (first.length === 0) return false;
  return first === compact(`${matched.title}${matched.artist}`) || first === compact(matched.title);
}

/** 통합검색 곡 목록: tr.list[songid] 행마다 a.title(TITLE 아이콘 span 제거) / a.artist / a.albumtitle */
function parseSearchRows(html: string): GenieRow[] {
  const $ = cheerio.load(html);
  const rows: GenieRow[] = [];
  $("tr[songid]").each((_, el) => {
    const row = $(el);
    const songId = row.attr("songid");
    if (!songId) return;
    const title = row.find("a.title").clone().children().remove().end().text().trim() || (row.find("a.title").attr("title") ?? "").trim();
    if (!title) return;
    const artist = row.find("a.artist").first().text().trim();
    const album = row.find("a.albumtitle").first().text().trim();
    rows.push({ songId, title, artist, album: album || undefined });
  });
  return rows;
}

/** get_msl.asp 응답: { "400":"line", "12040":"line", ... } (키=ms) */
function parseGenieMsl(jsonp: string): LyricLine[] {
  const start = jsonp.indexOf("{");
  const end = jsonp.lastIndexOf("}");
  if (start < 0 || end < 0) return [];
  let obj: Record<string, string>;
  try {
    obj = JSON.parse(jsonp.slice(start, end + 1));
  } catch {
    return [];
  }
  return Object.entries(obj)
    .map(([ms, text]) => ({ timeMs: Number(ms), text: String(text) }))
    .filter((l) => Number.isFinite(l.timeMs))
    .sort((a, b) => a.timeMs - b.timeMs);
}
