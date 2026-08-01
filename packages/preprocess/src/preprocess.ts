export const PREPROCESSOR_VERSION = "lyrics-clean-v1" as const;

export type LyricsLayer = "original" | "translation" | "romanization";

export interface OffsetMapEntry {
  derived_start: number;
  derived_end: number;
  source_start: number;
  source_end: number;
}

export interface ProcessedLyricsVariant {
  layer: LyricsLayer;
  language: string;
  text: string;
  confidence: number;
  review_required: boolean;
  rules: string[];
  offset_map: OffsetMapEntry[];
}

export interface PreprocessResult {
  version: typeof PREPROCESSOR_VERSION;
  variants: ProcessedLyricsVariant[];
  warnings: string[];
}

const sectionHeader = /^\s*[\[(](?:verse|pre-?chorus|chorus|bridge|hook|intro|outro|interlude|refrain|후렴|간주|도입|벌스|코러스|브릿지|サビ|イントロ|アウトロ)(?:\s+[^\])]+)?[\])]\s*$/iu;
const timestampPrefix = /^\s*(?:\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]\s*)+/u;
const metadataLine = /^\s*(?:lyrics?|written|writer|composer|작사|작곡|가사)\s*(?:by|:|：)/iu;
const repeatMarker = /^\s*[\[(]?(?:x\s*(\d+)|(\d+)\s*x|반복|repeat)[\])]?\s*$/iu;

function cpLength(value: string): number {
  return Array.from(value).length;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/gu, "\n").replace(/\u00a0/gu, " ");
}

function decodeEntities(value: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'",
  };
  return value.replace(/&(amp|lt|gt|quot|#39);/gu, (match) => entities[match] ?? match);
}

function inferredLayer(line: string): LyricsLayer {
  if (/^\s*(?:translation|번역|訳)\s*:/iu.test(line)) return "translation";
  if (/^\s*(?:romanization|romanized|로마자|ローマ字)\s*:/iu.test(line)) return "romanization";
  return "original";
}

function stripLayerLabel(line: string): string {
  return line.replace(/^\s*(?:translation|번역|訳|romanization|romanized|로마자|ローマ字)\s*:\s*/iu, "");
}

function buildVariant(lines: Array<{ text: string; sourceStart: number; sourceEnd: number }>, layer: LyricsLayer, language: string, rules: string[], reviewRequired: boolean): ProcessedLyricsVariant | null {
  if (lines.length === 0) return null;
  let cursor = 0;
  const offsets: OffsetMapEntry[] = [];
  const text = lines.map((line) => {
    const start = cursor;
    cursor += cpLength(line.text);
    offsets.push({ derived_start: start, derived_end: cursor, source_start: line.sourceStart, source_end: line.sourceEnd });
    cursor += 1;
    return line.text;
  }).join("\n");
  return { layer, language, text, confidence: reviewRequired ? 0.65 : 1, review_required: reviewRequired, rules: [...new Set(rules)], offset_map: offsets };
}

/** Keeps the immutable raw input outside this result; only derived text is returned. */
export function preprocessLyrics(raw: string, language = "und"): PreprocessResult {
  const normalized = decodeEntities(normalizeNewlines(raw)).normalize("NFC");
  const sourceLines = normalized.split("\n");
  const layers = new Map<LyricsLayer, Array<{ text: string; sourceStart: number; sourceEnd: number }>>();
  const rules: string[] = ["nfc", "newlines", "html-entities", "trim-whitespace"];
  const warnings: string[] = [];
  let sourceCursor = 0;
  let lastSection: Array<{ text: string; sourceStart: number; sourceEnd: number }> = [];
  let currentSection: Array<{ text: string; sourceStart: number; sourceEnd: number }> = [];
  let reviewRequired = false;

  for (const originalLine of sourceLines) {
    const sourceStart = sourceCursor;
    const sourceEnd = sourceCursor + cpLength(originalLine);
    sourceCursor = sourceEnd + 1;
    let line = originalLine.replace(timestampPrefix, "").trim().replace(/[\t ]+/gu, " ");
    if (line.length === 0) {
      if (currentSection.length > 0) { lastSection = currentSection; currentSection = []; }
      continue;
    }
    if (sectionHeader.test(line) || metadataLine.test(line)) {
      rules.push(sectionHeader.test(line) ? "section-header" : "metadata-line");
      if (currentSection.length > 0) { lastSection = currentSection; currentSection = []; }
      continue;
    }
    const repeat = repeatMarker.exec(line);
    if (repeat !== null) {
      const count = Number(repeat[1] ?? repeat[2] ?? "2");
      if (lastSection.length > 0 && Number.isInteger(count) && count >= 2 && count <= 4) {
        const target = layers.get("original") ?? [];
        for (let index = 1; index < count; index += 1) target.push(...lastSection.map((entry) => ({ ...entry })));
        layers.set("original", target);
        rules.push("repeat-expansion");
        reviewRequired = true;
      } else {
        warnings.push("UNRESOLVED_REPEAT");
        reviewRequired = true;
      }
      continue;
    }
    const layer = inferredLayer(line);
    line = stripLayerLabel(line);
    const entry = { text: line, sourceStart, sourceEnd };
    const target = layers.get(layer) ?? [];
    target.push(entry);
    layers.set(layer, target);
    if (layer === "original") currentSection.push(entry);
  }

  const original = layers.get("original") ?? [];
  if (original.length === 1 && cpLength(original[0]?.text ?? "") > 240) {
    warnings.push("SINGLE_LONG_LINE");
    reviewRequired = true;
  }

  const variants: ProcessedLyricsVariant[] = [];
  for (const [layer, lines] of layers) {
    const variant = buildVariant(lines, layer, language, rules, reviewRequired);
    if (variant !== null) variants.push(variant);
  }
  return { version: PREPROCESSOR_VERSION, variants, warnings };
}
