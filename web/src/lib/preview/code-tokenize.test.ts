import { describe, expect, test } from "bun:test";
import { type CodeToken, DEFAULT_MAX_LINE_CHARS, tokenizeCode } from "./code-tokenize";
import type { CodeLanguage } from "./file-kinds";

/** The rendered text of one line, which must equal the source line exactly. */
function lineText(tokens: CodeToken[]): string {
  return tokens.map((t) => t.text).join("");
}

function only(tokens: CodeToken[], kind: CodeToken["kind"]): string[] {
  return tokens.filter((t) => t.kind === kind).map((t) => t.text);
}

function roundTrips(source: string, language: CodeLanguage): boolean {
  const lines = tokenizeCode(source, language);
  return lines.map(lineText).join("\n") === source;
}

describe("tokenizeCode — losslessness", () => {
  // The single most important property: highlighting must never drop or
  // reorder a character. Everything else is cosmetic.
  const samples: Array<[CodeLanguage, string]> = [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: sample source, not a template
    ["ts", "const x: number = 42; // note\nexport function f() { return `a${x}b`; }\n"],
    ["python", 'def f(a):\n    """doc\n    string"""\n    return a # tail\n'],
    ["shell", '#!/bin/bash\nset -euo pipefail\necho "hi $HOME"\n'],
    ["rust", 'fn main() {\n    let s = "multi\nline";\n    /* block */\n}\n'],
    ["json", '{"a": 1, "b": [true, null], "c": "x"}\n'],
    ["xml", '<a href="x">text</a>\n<!-- c -->\n'],
    ["sql", "SELECT * FROM t -- note\nWHERE a = 'x';\n"],
    ["css", ".a { color: red; /* c */ }\n"],
    ["go", "package main\nfunc main() { println(`raw`) }\n"],
    ["plain", "anything at all\n\twith tabs\n"],
    ["yaml", "key: value # note\nlist:\n  - true\n"],
  ];

  for (const [language, source] of samples) {
    test(`${language} round-trips exactly`, () => {
      expect(roundTrips(source, language)).toBe(true);
    });
  }

  test("empty input yields one empty line", () => {
    expect(tokenizeCode("", "ts")).toEqual([[]]);
  });

  test("trailing newline keeps its empty final line", () => {
    const lines = tokenizeCode("a\n", "ts");
    expect(lines).toHaveLength(2);
    expect(lineText(lines[1] as CodeToken[])).toBe("");
  });
});

describe("tokenizeCode — comments", () => {
  test("line comments run to end of line only", () => {
    const [first, second] = tokenizeCode("let a = 1; // note\nlet b = 2;", "ts");
    expect(only(first as CodeToken[], "comment")).toEqual(["// note"]);
    expect(only(second as CodeToken[], "comment")).toEqual([]);
  });

  test("block comments span lines, one token per line", () => {
    const lines = tokenizeCode("/* one\ntwo */ after", "ts");
    expect(only(lines[0] as CodeToken[], "comment")).toEqual(["/* one"]);
    expect(only(lines[1] as CodeToken[], "comment")).toEqual(["two */"]);
    expect(lineText(lines[1] as CodeToken[])).toBe("two */ after");
  });

  test("an unterminated block comment runs to the end", () => {
    const lines = tokenizeCode("/* never closed\nstill\n", "ts");
    expect(only(lines[1] as CodeToken[], "comment")).toEqual(["still"]);
  });

  test("SQL uses double-dash comments", () => {
    const [line] = tokenizeCode("SELECT 1 -- why", "sql");
    expect(only(line as CodeToken[], "comment")).toEqual(["-- why"]);
  });
});

describe("tokenizeCode — strings", () => {
  test("escapes do not end a string", () => {
    const [line] = tokenizeCode('"a\\"b" rest', "ts");
    expect(only(line as CodeToken[], "string")).toEqual(['"a\\"b"']);
  });

  test("an unterminated single-line string stops at the newline", () => {
    // Otherwise one stray apostrophe paints the remainder of the file.
    const lines = tokenizeCode("it's fine\nlet a = 1;", "ts");
    expect(only(lines[1] as CodeToken[], "string")).toEqual([]);
    expect(only(lines[1] as CodeToken[], "keyword")).toEqual(["let"]);
  });

  test("template literals may span lines", () => {
    const lines = tokenizeCode("const a = `one\ntwo`;", "ts");
    expect(only(lines[0] as CodeToken[], "string")).toEqual(["`one"]);
    expect(only(lines[1] as CodeToken[], "string")).toEqual(["two`"]);
  });

  test("python triple quotes span lines", () => {
    const lines = tokenizeCode('x = """a\nb"""\ny = 1', "python");
    expect(only(lines[0] as CodeToken[], "string")).toEqual(['"""a']);
    expect(only(lines[2] as CodeToken[], "number")).toEqual(["1"]);
  });

  test("an unterminated string at EOF terminates the scan", () => {
    expect(roundTrips('const a = "open', "ts")).toBe(true);
  });
});

describe("tokenizeCode — numbers and keywords", () => {
  test("recognises decimals, hex, exponents and separators", () => {
    const [line] = tokenizeCode("a = 0xFF + 1_000 + 3.14 + 2e-9", "ts");
    expect(only(line as CodeToken[], "number")).toEqual(["0xFF", "1_000", "3.14", "2e-9"]);
  });

  test("a trailing dot is not swallowed into the number", () => {
    const [line] = tokenizeCode("x = 1.toString()", "ts");
    expect(only(line as CodeToken[], "number")).toEqual(["1"]);
  });

  test("keywords are matched whole, never as substrings", () => {
    const [line] = tokenizeCode("constant = 1; const b = 2;", "ts");
    expect(only(line as CodeToken[], "keyword")).toEqual(["const"]);
  });

  test("SQL keywords match case-insensitively", () => {
    const [line] = tokenizeCode("select A from T", "sql");
    expect(only(line as CodeToken[], "keyword")).toEqual(["select", "from"]);
  });

  test("case-sensitive languages do not match the wrong case", () => {
    const [line] = tokenizeCode("CONST a = 1;", "ts");
    expect(only(line as CodeToken[], "keyword")).toEqual([]);
  });
});

describe("tokenizeCode — markup", () => {
  test("splits tags, attributes and values", () => {
    const [line] = tokenizeCode("<a href=\"/x\" data-id='3'>t</a>", "xml");
    expect(only(line as CodeToken[], "tag")).toEqual(["a", "a"]);
    expect(only(line as CodeToken[], "attr")).toEqual(["href", "data-id"]);
    expect(only(line as CodeToken[], "string")).toEqual(['"/x"', "'3'"]);
  });

  test("markup comments are comments", () => {
    const [line] = tokenizeCode("<!-- hidden -->", "xml");
    expect(only(line as CodeToken[], "comment")).toEqual(["<!-- hidden -->"]);
  });

  test("text between tags stays plain", () => {
    const [line] = tokenizeCode("<b>bold</b>", "xml");
    expect(only(line as CodeToken[], "plain")).toContain("bold");
  });

  test("an unclosed tag does not run away", () => {
    expect(roundTrips('<a href="x"', "xml")).toBe(true);
  });
});

describe("tokenizeCode — limits", () => {
  test("caps the number of lines", () => {
    const source = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    expect(tokenizeCode(source, "plain", { maxLines: 20 })).toHaveLength(20);
  });

  test("truncates pathologically long lines", () => {
    const long = `const a = "${"x".repeat(9000)}";`;
    const [line] = tokenizeCode(long, "ts", { maxLineChars: 100 });
    expect(lineText(line as CodeToken[])).toHaveLength(100);
  });

  test("a minified single line is bounded by the default cap", () => {
    // The shape that would hang a backtracking highlighter.
    const minified = "a=1;".repeat(50_000);
    const [line] = tokenizeCode(minified, "js");
    expect(lineText(line as CodeToken[])).toHaveLength(DEFAULT_MAX_LINE_CHARS);
  });

  test("truncation never produces a token past the cap", () => {
    const long = "y".repeat(5000);
    const [line] = tokenizeCode(long, "plain", { maxLineChars: 10 });
    expect(lineText(line as CodeToken[])).toBe("yyyyyyyyyy");
  });
});
