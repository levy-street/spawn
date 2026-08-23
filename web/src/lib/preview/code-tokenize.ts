/**
 * A small, linear-time syntax highlighter.
 *
 * File contents are untrusted and arbitrarily shaped, so this is a single
 * forward pass over the source with no backtracking anywhere: a regex-driven
 * highlighter fed a pathological file can hang the tab, and a hover preview is
 * the worst possible place for that. The trade is fidelity — this knows about
 * comments, strings, numbers and keywords, and nothing else. For a preview that
 * is enough, and `tokenizeCode` is the seam to swap in something heavier later.
 *
 * Every token carries its own text and the result is grouped by line, so the
 * renderer never has to slice the source itself.
 */

import type { CodeLanguage } from "./file-kinds";

export type TokenKind =
  | "plain"
  | "comment"
  | "string"
  | "keyword"
  | "number"
  | "tag"
  | "attr"
  | "punct";

export type CodeToken = { kind: TokenKind; text: string };

export type TokenizeLimits = {
  /** Lines beyond this are dropped. */
  maxLines?: number;
  /** Characters beyond this on any one line are dropped, minified files included. */
  maxLineChars?: number;
};

export const DEFAULT_MAX_LINES = 5000;
export const DEFAULT_MAX_LINE_CHARS = 2000;

type Span = { kind: TokenKind; start: number; end: number };

type LangConfig = {
  lineComments: string[];
  blockComment: [string, string] | null;
  quotes: string[];
  /** Quotes that may legally span lines (template literals, Python triples). */
  multilineQuotes: string[];
  tripleQuotes: string[];
  escapes: boolean;
  keywords: Set<string>;
  caseInsensitive?: boolean;
  markup?: boolean;
};

const PUNCT = /[{}()[\].,;:+\-*/%=<>!&|^~?@#$]/;
const DIGIT = /[0-9]/;
const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const HEX_PART = /[0-9a-fA-F_]/;
const NUM_PART = /[0-9_]/;

function words(list: string): Set<string> {
  return new Set(list.split(/\s+/u).filter(Boolean));
}

const C_LIKE = words(`
  if else for while do switch case default break continue return goto
  class struct enum union interface extends implements new delete this super
  public private protected static final abstract virtual override
  try catch finally throw throws
  const let var int long short char float double void bool boolean auto
  namespace using typedef template typename operator sizeof
  import export package module def end nil true false null undefined self
`);

const CONFIGS: Record<CodeLanguage, LangConfig> = {
  "c-like": {
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'"],
    multilineQuotes: [],
    tripleQuotes: [],
    escapes: true,
    keywords: C_LIKE,
  },
  js: {
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'", "`"],
    multilineQuotes: ["`"],
    tripleQuotes: [],
    escapes: true,
    keywords: words(`
      if else for while do switch case default break continue return
      function class extends new delete typeof instanceof in of
      var let const async await yield try catch finally throw
      import export from as default this super static get set
      true false null undefined void
    `),
  },
  ts: {
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'", "`"],
    multilineQuotes: ["`"],
    tripleQuotes: [],
    escapes: true,
    keywords: words(`
      if else for while do switch case default break continue return
      function class extends implements new delete typeof instanceof in of
      var let const async await yield try catch finally throw
      import export from as default this super static get set
      interface type enum namespace declare abstract readonly keyof infer satisfies
      public private protected optional never unknown any string number boolean
      true false null undefined void
    `),
  },
  jsx: {
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'", "`"],
    multilineQuotes: ["`"],
    tripleQuotes: [],
    escapes: true,
    keywords: words(`
      if else for while do switch case default break continue return
      function class extends implements new delete typeof instanceof in of
      var let const async await yield try catch finally throw
      import export from as default this super static get set
      interface type enum namespace declare abstract readonly
      true false null undefined void
    `),
  },
  python: {
    lineComments: ["#"],
    blockComment: null,
    quotes: ['"', "'"],
    multilineQuotes: [],
    tripleQuotes: ['"""', "'''"],
    escapes: true,
    keywords: words(`
      def class lambda return yield pass break continue
      if elif else for while with as try except finally raise assert
      import from global nonlocal del in is not and or
      True False None self async await match case
    `),
  },
  shell: {
    lineComments: ["#"],
    blockComment: null,
    quotes: ['"', "'"],
    multilineQuotes: [],
    tripleQuotes: [],
    escapes: true,
    keywords: words(`
      if then elif else fi for while until do done case esac function
      return exit break continue local export readonly declare source
      echo cd set unset trap shift eval exec test in select time
    `),
  },
  rust: {
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"'],
    multilineQuotes: ['"'],
    tripleQuotes: [],
    escapes: true,
    keywords: words(`
      fn let mut const static struct enum trait impl for while loop
      if else match return break continue where type use mod pub crate
      self super as in ref move dyn async await unsafe extern
      true false Some None Ok Err
    `),
  },
  go: {
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'", "`"],
    multilineQuotes: ["`"],
    tripleQuotes: [],
    escapes: true,
    keywords: words(`
      func var const type struct interface map chan package import
      if else for range switch case default break continue return
      go defer select fallthrough goto
      true false nil iota make new len cap append
    `),
  },
  css: {
    lineComments: ["//"],
    blockComment: ["/*", "*/"],
    quotes: ['"', "'"],
    multilineQuotes: [],
    tripleQuotes: [],
    escapes: true,
    keywords: words(`
      important inherit initial unset auto none from to
      media supports keyframes import charset font-face
    `),
  },
  json: {
    lineComments: [],
    blockComment: null,
    quotes: ['"'],
    multilineQuotes: [],
    tripleQuotes: [],
    escapes: true,
    keywords: words("true false null"),
  },
  yaml: {
    lineComments: ["#"],
    blockComment: null,
    quotes: ['"', "'"],
    multilineQuotes: [],
    tripleQuotes: [],
    escapes: true,
    keywords: words("true false null yes no on off"),
  },
  toml: {
    lineComments: ["#", ";"],
    blockComment: null,
    quotes: ['"', "'"],
    multilineQuotes: [],
    tripleQuotes: ['"""', "'''"],
    escapes: true,
    keywords: words("true false"),
  },
  sql: {
    lineComments: ["--"],
    blockComment: ["/*", "*/"],
    quotes: ["'", '"'],
    multilineQuotes: [],
    tripleQuotes: [],
    escapes: false,
    caseInsensitive: true,
    keywords: words(`
      select from where group by having order limit offset
      insert into values update set delete create table drop alter add
      index view join inner left right outer full on as union all distinct
      and or not null is in like between exists case when then else end
      primary key foreign references unique default constraint returning
      begin commit rollback with recursive
    `),
  },
  xml: {
    lineComments: [],
    blockComment: ["<!--", "-->"],
    quotes: ['"', "'"],
    multilineQuotes: ['"', "'"],
    tripleQuotes: [],
    escapes: false,
    keywords: new Set<string>(),
    markup: true,
  },
  markdown: {
    lineComments: [],
    blockComment: null,
    quotes: [],
    multilineQuotes: [],
    tripleQuotes: [],
    escapes: false,
    keywords: new Set<string>(),
  },
  plain: {
    lineComments: [],
    blockComment: null,
    quotes: [],
    multilineQuotes: [],
    tripleQuotes: [],
    escapes: false,
    keywords: new Set<string>(),
  },
};

export function tokenizeCode(
  source: string,
  language: CodeLanguage,
  limits: TokenizeLimits = {},
): CodeToken[][] {
  const maxLines = limits.maxLines ?? DEFAULT_MAX_LINES;
  const maxLineChars = limits.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;

  let lines = source.split("\n");
  if (lines.length > maxLines) lines = lines.slice(0, maxLines);
  // Truncate before scanning, not after: a single 4 MB minified line is the
  // one shape that makes even a linear scan feel like a hang.
  lines = lines.map((line) => (line.length > maxLineChars ? line.slice(0, maxLineChars) : line));

  const text = lines.join("\n");
  const config = CONFIGS[language] ?? CONFIGS.plain;
  const spans = config.markup ? scanMarkup(text) : scanSource(text, config);
  return splitByLine(text, spans, lines.length);
}

function scanSource(text: string, config: LangConfig): Span[] {
  const spans: Span[] = [];
  let plainStart = 0;
  let i = 0;

  const flush = (end: number) => {
    if (end > plainStart) spans.push({ kind: "plain", start: plainStart, end });
  };
  const push = (kind: TokenKind, start: number, end: number) => {
    flush(start);
    spans.push({ kind, start, end });
    plainStart = end;
  };

  while (i < text.length) {
    const ch = text[i] as string;

    const lineComment = config.lineComments.find((marker) => text.startsWith(marker, i));
    if (lineComment !== undefined) {
      const newline = text.indexOf("\n", i);
      const end = newline === -1 ? text.length : newline;
      push("comment", i, end);
      i = end;
      continue;
    }

    if (config.blockComment && text.startsWith(config.blockComment[0], i)) {
      const [open, close] = config.blockComment;
      const found = text.indexOf(close, i + open.length);
      // Unterminated block comment runs to the end of the file, which is what
      // an editor shows too.
      const end = found === -1 ? text.length : found + close.length;
      push("comment", i, end);
      i = end;
      continue;
    }

    const triple = config.tripleQuotes.find((marker) => text.startsWith(marker, i));
    if (triple !== undefined) {
      const found = text.indexOf(triple, i + triple.length);
      const end = found === -1 ? text.length : found + triple.length;
      push("string", i, end);
      i = end;
      continue;
    }

    if (config.quotes.includes(ch)) {
      const end = scanString(text, i, ch, config);
      push("string", i, end);
      i = end;
      continue;
    }

    if (DIGIT.test(ch) || (ch === "." && DIGIT.test(text[i + 1] ?? ""))) {
      const end = scanNumber(text, i);
      push("number", i, end);
      i = end;
      continue;
    }

    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < text.length && IDENT_PART.test(text[j] as string)) j += 1;
      const word = text.slice(i, j);
      const lookup = config.caseInsensitive ? word.toLowerCase() : word;
      // Non-keywords stay part of the surrounding plain run — no token needed.
      if (config.keywords.has(lookup)) push("keyword", i, j);
      i = j;
      continue;
    }

    if (PUNCT.test(ch)) {
      push("punct", i, i + 1);
      i += 1;
      continue;
    }

    i += 1;
  }

  flush(text.length);
  return spans;
}

function scanString(text: string, start: number, quote: string, config: LangConfig): number {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i] as string;
    if (config.escapes && ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    // An unterminated single-line string stops at the newline. Without this a
    // stray apostrophe would paint the rest of the file as a string.
    if (ch === "\n" && !config.multilineQuotes.includes(quote)) return i;
    i += 1;
  }
  return text.length;
}

function scanNumber(text: string, start: number): number {
  let i = start;
  const prefix = text[i + 1];
  if (text[i] === "0" && prefix !== undefined && /[xXbBoO]/.test(prefix)) {
    i += 2;
    while (i < text.length && HEX_PART.test(text[i] as string)) i += 1;
    return i;
  }
  while (i < text.length && NUM_PART.test(text[i] as string)) i += 1;
  if (text[i] === "." && DIGIT.test(text[i + 1] ?? "")) {
    i += 1;
    while (i < text.length && NUM_PART.test(text[i] as string)) i += 1;
  }
  if (text[i] === "e" || text[i] === "E") {
    let j = i + 1;
    if (text[j] === "+" || text[j] === "-") j += 1;
    if (DIGIT.test(text[j] ?? "")) {
      i = j;
      while (i < text.length && NUM_PART.test(text[i] as string)) i += 1;
    }
  }
  return i;
}

function scanMarkup(text: string): Span[] {
  const spans: Span[] = [];
  let plainStart = 0;
  let i = 0;

  const flush = (end: number) => {
    if (end > plainStart) spans.push({ kind: "plain", start: plainStart, end });
  };
  const push = (kind: TokenKind, start: number, end: number) => {
    flush(start);
    spans.push({ kind, start, end });
    plainStart = end;
  };
  const name = (from: number): number => {
    let k = from;
    while (k < text.length) {
      const ch = text[k] as string;
      if (!IDENT_PART.test(ch) && ch !== "-" && ch !== ":" && ch !== ".") break;
      k += 1;
    }
    return k;
  };

  while (i < text.length) {
    if (text.startsWith("<!--", i)) {
      const found = text.indexOf("-->", i + 4);
      const end = found === -1 ? text.length : found + 3;
      push("comment", i, end);
      i = end;
      continue;
    }

    if (text[i] === "<") {
      let j = i + 1;
      const next = text[j];
      if (next === "/" || next === "!" || next === "?") j += 1;
      push("punct", i, j);
      i = j;

      if (IDENT_START.test(text[i] ?? "")) {
        const end = name(i);
        push("tag", i, end);
        i = end;
      }

      while (i < text.length && text[i] !== ">") {
        const ch = text[i] as string;
        if (ch === '"' || ch === "'") {
          const found = text.indexOf(ch, i + 1);
          const end = found === -1 ? text.length : found + 1;
          push("string", i, end);
          i = end;
          continue;
        }
        if (IDENT_START.test(ch)) {
          const end = name(i);
          push("attr", i, end);
          i = end;
          continue;
        }
        if (ch === "=" || ch === "/") {
          push("punct", i, i + 1);
          i += 1;
          continue;
        }
        i += 1;
      }

      if (i < text.length && text[i] === ">") {
        push("punct", i, i + 1);
        i += 1;
      }
      continue;
    }

    i += 1;
  }

  flush(text.length);
  return spans;
}

/**
 * Regroup contiguous spans into one array per line. Spans may straddle
 * newlines (a block comment, a template literal), so they are cut at every one.
 */
function splitByLine(text: string, spans: Span[], lineCount: number): CodeToken[][] {
  const out: CodeToken[][] = Array.from({ length: lineCount }, () => []);
  let line = 0;

  for (const span of spans) {
    let start = span.start;
    while (start < span.end) {
      const newline = text.indexOf("\n", start);
      const cut = newline === -1 || newline >= span.end ? span.end : newline;
      if (cut > start && line < lineCount) {
        (out[line] as CodeToken[]).push({ kind: span.kind, text: text.slice(start, cut) });
      }
      if (newline !== -1 && newline < span.end) {
        line += 1;
        start = newline + 1;
      } else {
        start = cut;
      }
    }
  }

  return out;
}
