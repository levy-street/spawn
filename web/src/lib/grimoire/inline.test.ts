import { describe, expect, it } from "bun:test";
import { inlineLinks, parseInline, stripInline } from "./inline";

describe("inline markup", () => {
  it("passes plain text through untouched", () => {
    expect(parseInline("A sentence with no marks.")).toEqual([
      { kind: "text", text: "A sentence with no marks." },
    ]);
  });

  it("lifts code spans and links, keeping the text between them", () => {
    expect(parseInline("Run `claude --resume` or read [the docs](https://x.y/z).")).toEqual([
      { kind: "text", text: "Run " },
      { kind: "code", text: "claude --resume" },
      { kind: "text", text: " or read " },
      { kind: "link", text: "the docs", href: "https://x.y/z" },
      { kind: "text", text: "." },
    ]);
  });

  it("leaves stray brackets and backticks as text", () => {
    expect(parseInline("settings[0] and a ` alone")).toEqual([
      { kind: "text", text: "settings[0] and a ` alone" },
    ]);
  });

  it("lists hrefs and strips marks for schema text", () => {
    const source = "See [a](/one) and [b](/two) with `c`.";
    expect(inlineLinks(source)).toEqual(["/one", "/two"]);
    expect(stripInline(source)).toBe("See a and b with c.");
  });
});
