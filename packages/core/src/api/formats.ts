import { ServiceError } from "../shared/errors.js";
import type { AlignmentResult, OffsetTimeSpan, ProjectedOffsetTimeSpan } from "../shared/types.js";

export type OutputFormat = "spans" | "lrc-a2" | "lyricsfile" | "ttml" | "webvtt";

export interface SerializedOutput {
  contentType: string;
  body: string;
}

function seconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(3)}s`;
}

function vttTime(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${secs
    .toString()
    .padStart(2, "0")}.${millis.toString().padStart(3, "0")}`;
}

function lrcTime(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  const secondsPart = Math.floor((milliseconds % 60_000) / 1000);
  const centiseconds = Math.floor((milliseconds % 1000) / 10);
  return `${minutes.toString().padStart(2, "0")}:${secondsPart.toString().padStart(2, "0")}.${centiseconds.toString().padStart(2, "0")}`;
}

function formatLrc(result: AlignmentResult): string {
  return result.lines
    .map(([lineStart, lineEnd, startMs, endMs]) => {
      const words = result.spans.filter(([start, end]) => start >= lineStart && end <= lineEnd);
      const enhanced = words.map(([start, end, wordStart]) => `<${lrcTime(wordStart)}>${start}:${end}`).join("");
      return `[${lrcTime(startMs)}]${lineStart}:${lineEnd}${enhanced}<${lrcTime(endMs)}>`;
    })
    .join("\n");
}

function formatLyricsfile(result: AlignmentResult): string {
  const rows = (name: string, spans: Array<OffsetTimeSpan | ProjectedOffsetTimeSpan>): string[] => [
    `${name}:`,
    ...spans.map((span) => `  - [${span.join(", ")}]`),
  ];
  return [
    "version: 1",
    `tier: ${result.tier}`,
    "offset_unit: codepoint",
    `alignment_id: ${result.alignment_id}`,
    ...rows("lines", result.lines),
    ...rows("spans", result.spans),
    "",
  ].join("\n");
}

function formatTtml(result: AlignmentResult): string {
  const spans = result.spans
    .map(
      ([start, end, startMs, endMs]) =>
        `<span begin="${seconds(startMs)}" end="${seconds(endMs)}" data-cp-start="${start}" data-cp-end="${end}"/>`,
    )
    .join("");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:service="urn:service:word-timing:v1">',
    `<body service:tier="${result.tier}" service:alignment-id="${result.alignment_id}"><div><p>${spans}</p></div></body>`,
    "</tt>",
  ].join("");
}

function formatWebVtt(result: AlignmentResult): string {
  const source = result.tier === "line" ? result.lines : result.spans;
  const cues = source.map(([start, end, startMs, endMs], index) =>
    [index + 1, `${vttTime(startMs)} --> ${vttTime(endMs)}`, `${start} ${end}`, ""].join("\n"),
  );
  return ["WEBVTT", "", ...cues].join("\n");
}

/**
 * Text-bearing formats are emitted as numeric overlay variants: their cue
 * payload is a codepoint range, never a lyric fragment.
 */
export function serializeOutput(result: AlignmentResult, value: string | null): SerializedOutput {
  const format = value ?? "spans";
  switch (format) {
    case "spans":
      return { contentType: "application/json; charset=utf-8", body: JSON.stringify(result) };
    case "lrc-a2":
      return { contentType: "text/plain; charset=utf-8", body: formatLrc(result) };
    case "lyricsfile":
      return { contentType: "application/yaml; charset=utf-8", body: formatLyricsfile(result) };
    case "ttml":
      return { contentType: "application/ttml+xml; charset=utf-8", body: formatTtml(result) };
    case "webvtt":
      return { contentType: "text/vtt; charset=utf-8", body: formatWebVtt(result) };
    default:
      throw new ServiceError(400, "UNSUPPORTED_FORMAT");
  }
}
