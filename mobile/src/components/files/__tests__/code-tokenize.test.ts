import { tokenizeCode } from "@/components/files/code-tokenize";
import type { CodeLanguage } from "@/components/files/types";

function rebuild(lines: ReturnType<typeof tokenizeCode>): string {
  return lines.map((line) => line.map((token) => token.text).join("")).join("\n");
}

describe("bounded code tokenizer", () => {
  test.each<readonly [CodeLanguage, string]>([
    ["ts", "const answer = 42; // yes"],
    ["python", "def greet():\n    return 'hi'"],
    ["shell", "if test -f file; then # note\n echo yes\nfi"],
    ["rust", "fn main() { /* note */ let n = 1; }"],
    ["sql", "SELECT id FROM users WHERE id = 9"],
    ["xml", '<note id="1"><body>Hello</body></note>'],
  ])("is lossless for %s", (language, source) => {
    expect(rebuild(tokenizeCode(source, language))).toBe(source);
  });

  it("recognizes comments, strings, keywords, numbers, and markup", () => {
    const kinds = tokenizeCode("const value = `hi`; // 42", "ts")
      .flat()
      .map((token) => token.kind);
    expect(kinds).toEqual(expect.arrayContaining(["keyword", "string", "comment", "punct"]));
    const markup = tokenizeCode('<tag attr="value">', "xml")
      .flat()
      .map((token) => token.kind);
    expect(markup).toEqual(expect.arrayContaining(["tag", "attr", "string", "punct"]));
  });

  it("caps lines and minified-line length before scanning", () => {
    const result = tokenizeCode("abcdefghij\nsecond\nthird", "js", {
      maxLines: 2,
      maxLineChars: 4,
    });
    expect(rebuild(result)).toBe("abcd\nseco");
  });
});
