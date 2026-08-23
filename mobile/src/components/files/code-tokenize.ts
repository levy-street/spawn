import { LANGUAGE_CONFIGS, type LanguageConfig } from "@/components/files/code-token-config";
import type { CodeLanguage } from "@/components/files/types";

export type TokenKind =
  | "plain"
  | "comment"
  | "string"
  | "keyword"
  | "number"
  | "tag"
  | "attr"
  | "punct";

export interface CodeToken {
  kind: TokenKind;
  text: string;
}

export interface TokenizeLimits {
  maxLines?: number;
  maxLineChars?: number;
}

export const DEFAULT_MAX_LINES = 5000;
export const DEFAULT_MAX_LINE_CHARS = 2000;

interface Span {
  kind: TokenKind;
  start: number;
  end: number;
}

const PUNCT = /[{}()[\].,;:+\-*/%=<>!&|^~?@#$]/;
const DIGIT = /[0-9]/;
const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const HEX_PART = /[0-9a-fA-F_]/;
const NUM_PART = /[0-9_]/;

export function tokenizeCode(
  source: string,
  language: CodeLanguage,
  limits: TokenizeLimits = {},
): CodeToken[][] {
  const maxLines = limits.maxLines ?? DEFAULT_MAX_LINES;
  const maxLineChars = limits.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  let lines = source.split("\n");
  if (lines.length > maxLines) lines = lines.slice(0, maxLines);
  lines = lines.map((line) => (line.length > maxLineChars ? line.slice(0, maxLineChars) : line));
  const text = lines.join("\n");
  const config = LANGUAGE_CONFIGS[language] ?? LANGUAGE_CONFIGS.plain;
  const spans = config.markup ? scanMarkup(text) : scanSource(text, config);
  return splitByLine(text, spans, lines.length);
}

function scanSource(text: string, config: LanguageConfig): Span[] {
  const spans: Span[] = [];
  let plainStart = 0;
  let index = 0;
  const flush = (end: number) => {
    if (end > plainStart) spans.push({ kind: "plain", start: plainStart, end });
  };
  const push = (kind: TokenKind, start: number, end: number) => {
    flush(start);
    spans.push({ kind, start, end });
    plainStart = end;
  };

  while (index < text.length) {
    const char = text[index] as string;
    const lineComment = config.lineComments.find((marker) => text.startsWith(marker, index));
    if (lineComment !== undefined) {
      const newline = text.indexOf("\n", index);
      const end = newline === -1 ? text.length : newline;
      push("comment", index, end);
      index = end;
      continue;
    }
    if (config.blockComment && text.startsWith(config.blockComment[0], index)) {
      const [open, close] = config.blockComment;
      const found = text.indexOf(close, index + open.length);
      const end = found === -1 ? text.length : found + close.length;
      push("comment", index, end);
      index = end;
      continue;
    }
    const triple = config.tripleQuotes.find((marker) => text.startsWith(marker, index));
    if (triple !== undefined) {
      const found = text.indexOf(triple, index + triple.length);
      const end = found === -1 ? text.length : found + triple.length;
      push("string", index, end);
      index = end;
      continue;
    }
    if (config.quotes.includes(char)) {
      const end = scanString(text, index, char, config);
      push("string", index, end);
      index = end;
      continue;
    }
    if (DIGIT.test(char) || (char === "." && DIGIT.test(text[index + 1] ?? ""))) {
      const end = scanNumber(text, index);
      push("number", index, end);
      index = end;
      continue;
    }
    if (IDENT_START.test(char)) {
      let end = index + 1;
      while (end < text.length && IDENT_PART.test(text[end] as string)) end += 1;
      const word = text.slice(index, end);
      if (config.keywords.has(config.caseInsensitive ? word.toLowerCase() : word)) {
        push("keyword", index, end);
      }
      index = end;
      continue;
    }
    if (PUNCT.test(char)) {
      push("punct", index, index + 1);
      index += 1;
      continue;
    }
    index += 1;
  }
  flush(text.length);
  return spans;
}

function scanString(text: string, start: number, quote: string, config: LanguageConfig): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index] as string;
    if (config.escapes && char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    if (char === "\n" && !config.multilineQuotes.includes(quote)) return index;
    index += 1;
  }
  return text.length;
}

function scanNumber(text: string, start: number): number {
  let index = start;
  const prefix = text[index + 1];
  if (text[index] === "0" && prefix !== undefined && /[xXbBoO]/.test(prefix)) {
    index += 2;
    while (index < text.length && HEX_PART.test(text[index] as string)) index += 1;
    return index;
  }
  while (index < text.length && NUM_PART.test(text[index] as string)) index += 1;
  if (text[index] === "." && DIGIT.test(text[index + 1] ?? "")) {
    index += 1;
    while (index < text.length && NUM_PART.test(text[index] as string)) index += 1;
  }
  if (text[index] === "e" || text[index] === "E") {
    let next = index + 1;
    if (text[next] === "+" || text[next] === "-") next += 1;
    if (DIGIT.test(text[next] ?? "")) {
      index = next;
      while (index < text.length && NUM_PART.test(text[index] as string)) index += 1;
    }
  }
  return index;
}

function scanMarkup(text: string): Span[] {
  const spans: Span[] = [];
  let plainStart = 0;
  let index = 0;
  const flush = (end: number) => {
    if (end > plainStart) spans.push({ kind: "plain", start: plainStart, end });
  };
  const push = (kind: TokenKind, start: number, end: number) => {
    flush(start);
    spans.push({ kind, start, end });
    plainStart = end;
  };
  const nameEnd = (start: number): number => {
    let end = start;
    while (end < text.length) {
      const char = text[end] as string;
      if (!IDENT_PART.test(char) && char !== "-" && char !== ":" && char !== ".") break;
      end += 1;
    }
    return end;
  };

  while (index < text.length) {
    if (text.startsWith("<!--", index)) {
      const found = text.indexOf("-->", index + 4);
      const end = found === -1 ? text.length : found + 3;
      push("comment", index, end);
      index = end;
      continue;
    }
    if (text[index] !== "<") {
      index += 1;
      continue;
    }
    let next = index + 1;
    if (text[next] === "/" || text[next] === "!" || text[next] === "?") next += 1;
    push("punct", index, next);
    index = next;
    if (IDENT_START.test(text[index] ?? "")) {
      const end = nameEnd(index);
      push("tag", index, end);
      index = end;
    }
    while (index < text.length && text[index] !== ">") {
      const char = text[index] as string;
      if (char === '"' || char === "'") {
        const found = text.indexOf(char, index + 1);
        const end = found === -1 ? text.length : found + 1;
        push("string", index, end);
        index = end;
      } else if (IDENT_START.test(char)) {
        const end = nameEnd(index);
        push("attr", index, end);
        index = end;
      } else if (char === "=" || char === "/") {
        push("punct", index, index + 1);
        index += 1;
      } else index += 1;
    }
    if (index < text.length) {
      push("punct", index, index + 1);
      index += 1;
    }
  }
  flush(text.length);
  return spans;
}

function splitByLine(text: string, spans: readonly Span[], lineCount: number): CodeToken[][] {
  const output: CodeToken[][] = Array.from({ length: lineCount }, () => []);
  let line = 0;
  for (const span of spans) {
    let start = span.start;
    while (start < span.end) {
      const newline = text.indexOf("\n", start);
      const cut = newline === -1 || newline >= span.end ? span.end : newline;
      if (cut > start && line < lineCount) {
        output[line]?.push({ kind: span.kind, text: text.slice(start, cut) });
      }
      if (newline !== -1 && newline < span.end) {
        line += 1;
        start = newline + 1;
      } else start = cut;
    }
  }
  return output;
}
