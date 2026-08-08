import { TOKENIZER, type Token, type TokenType, type Tokenization, type TokenizedLine } from "../shared/types.js";

interface Unit {
  char: string;
  originalStart: number;
  originalEnd: number;
  masked: boolean;
}

interface RawLine {
  index: number;
  start: number;
  end: number;
  codepoints: string[];
}

const punctuation = /^\p{P}$/u;
const whitespace = /^\s$/u;
const hangul = /^(?:\p{Script=Hangul}|\p{M})+$/u;
const latin = /^(?:\p{Script=Latin}|\p{M})+$/u;
const number = /^\p{N}+$/u;

const doubleQuotes = new Set(["“", "”", "„", "‟", "＂"]);
const singleQuotes = new Set(["‘", "’", "‚", "‛", "`", "´", "＇"]);

function splitRawLines(text: string): RawLine[] {
  const codepoints = Array.from(text);
  const lines: RawLine[] = [];
  let start = 0;
  let lineIndex = 0;

  for (let index = 0; index < codepoints.length; index += 1) {
    const current = codepoints[index];
    if (current !== "\n" && current !== "\r") continue;

    lines.push({
      index: lineIndex,
      start,
      end: index,
      codepoints: codepoints.slice(start, index),
    });
    lineIndex += 1;

    if (current === "\r" && codepoints[index + 1] === "\n") index += 1;
    start = index + 1;
  }

  lines.push({
    index: lineIndex,
    start,
    end: codepoints.length,
    codepoints: codepoints.slice(start),
  });
  return lines;
}

function foldCodepoint(char: string): string {
  if (doubleQuotes.has(char)) return '"';
  if (singleQuotes.has(char)) return "'";

  const lowered = char.toLocaleLowerCase("und");
  return Array.from(lowered).length === 1 ? lowered : char;
}

function normalizeLine(line: RawLine): Unit[] {
  const raw = line.codepoints.join("");
  const units: Unit[] = [];
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  let originalCursor = line.start;

  for (const part of segmenter.segment(raw)) {
    const originalLength = Array.from(part.segment).length;
    const normalized = Array.from(part.segment.normalize("NFC"));
    const originalStart = originalCursor;
    const originalEnd = originalCursor + originalLength;

    for (const codepoint of normalized) {
      units.push({
        char: foldCodepoint(codepoint),
        originalStart,
        originalEnd,
        masked: false,
      });
    }
    originalCursor = originalEnd;
  }

  return units;
}

function maskBracketedSections(units: Unit[]): void {
  const stack: string[] = [];
  const closingFor: Record<string, string> = { "(": ")", "[": "]" };

  for (const unit of units) {
    if (unit.char === "(" || unit.char === "[") {
      stack.push(closingFor[unit.char] ?? "");
      unit.masked = true;
      continue;
    }

    if (stack.length > 0) {
      unit.masked = true;
      if (unit.char === stack.at(-1)) stack.pop();
    }
  }
}

function tokenType(canonical: string): TokenType {
  if (hangul.test(canonical)) return 0;
  if (latin.test(canonical)) return 1;
  if (number.test(canonical)) return 2;
  return 3;
}

function toToken(candidate: Unit[], line: number): Token | null {
  let left = 0;
  let right = candidate.length;

  while (left < right && punctuation.test(candidate[left]?.char ?? "")) left += 1;
  while (right > left && punctuation.test(candidate[right - 1]?.char ?? "")) right -= 1;
  if (left === right) return null;

  const narrowed = candidate.slice(left, right);
  const first = narrowed[0];
  const last = narrowed.at(-1);
  if (first === undefined || last === undefined) return null;

  const canonical = narrowed.map((unit) => unit.char).join("");
  return {
    start: first.originalStart,
    end: last.originalEnd,
    line,
    length: Array.from(canonical).length,
    type: tokenType(canonical),
    canonical,
  };
}

function tokenizeLine(units: Unit[], lineIndex: number): Token[] {
  const tokens: Token[] = [];
  let candidate: Unit[] = [];

  const flush = (): void => {
    if (candidate.length === 0) return;
    const token = toToken(candidate, lineIndex);
    if (token !== null) tokens.push(token);
    candidate = [];
  };

  for (const unit of units) {
    if (unit.masked || whitespace.test(unit.char)) {
      flush();
      continue;
    }
    candidate.push(unit);
  }
  flush();
  return tokens;
}

/**
 * Tokenizes text while returning offsets in the original Unicode-codepoint
 * coordinate system. Canonical text is ephemeral and must never be persisted.
 */
export function tokenize(text: string): Tokenization {
  const tokens: Token[] = [];
  const lines: TokenizedLine[] = [];

  for (const rawLine of splitRawLines(text)) {
    const units = normalizeLine(rawLine);
    maskBracketedSections(units);
    const lineTokens = tokenizeLine(units, rawLine.index);
    const tokenIndices: number[] = [];

    for (const token of lineTokens) {
      tokenIndices.push(tokens.length);
      tokens.push(token);
    }

    const hasVisibleContent = units.some((unit) => !whitespace.test(unit.char));
    const hasUnmaskedContent = units.some((unit) => !unit.masked && !whitespace.test(unit.char) && !punctuation.test(unit.char));
    lines.push({
      index: rawLine.index,
      start: rawLine.start,
      end: rawLine.end,
      tokenIndices,
      excluded: hasVisibleContent && !hasUnmaskedContent,
    });
  }

  const canonical = lines
    .filter((line) => !line.excluded && line.tokenIndices.length > 0)
    .map((line) => line.tokenIndices.map((index) => tokens[index]?.canonical ?? "").join(" "))
    .join("\n");

  return { tokenizer: TOKENIZER, tokens, lines, canonical };
}

export function publicTokens(tokenization: Tokenization): Array<[number, number, number]> {
  return tokenization.tokens.map(({ start, end, line }) => [start, end, line]);
}

export function activeLines(tokenization: Tokenization): TokenizedLine[] {
  return tokenization.lines.filter((line) => !line.excluded && line.tokenIndices.length > 0);
}
