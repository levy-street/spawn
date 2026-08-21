import { describe, expect, test } from "bun:test";
import { decodeText, looksBinary, partialTailLength } from "./text-decode";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("looksBinary", () => {
  test("plain text is not binary", () => {
    expect(looksBinary(utf8("hello\nworld\n"))).toBe(false);
  });

  test("a NUL byte marks it binary", () => {
    expect(looksBinary(new Uint8Array([0x68, 0x00, 0x69]))).toBe(true);
  });

  test("only the sniff window is scanned", () => {
    // A NUL far past the window is not our problem: the head read that feeds
    // this only ever holds the first few KiB anyway.
    const bytes = new Uint8Array(9000);
    bytes.fill(0x61);
    bytes[8000] = 0;
    expect(looksBinary(bytes)).toBe(false);
  });

  test("an empty buffer is not binary", () => {
    expect(looksBinary(new Uint8Array())).toBe(false);
  });
});

describe("partialTailLength", () => {
  test("a clean ASCII boundary has no tail", () => {
    expect(partialTailLength(utf8("abc"))).toBe(0);
  });

  test("a complete multi-byte character has no tail", () => {
    expect(partialTailLength(utf8("héllo"))).toBe(0);
    expect(partialTailLength(utf8("emoji 🎉"))).toBe(0);
  });

  test("a truncated two-byte character reports its tail", () => {
    const full = utf8("é");
    expect(partialTailLength(full.subarray(0, 1))).toBe(1);
  });

  test("a truncated four-byte character reports its tail at every cut", () => {
    const full = utf8("🎉");
    expect(full.length).toBe(4);
    expect(partialTailLength(full.subarray(0, 1))).toBe(1);
    expect(partialTailLength(full.subarray(0, 2))).toBe(2);
    expect(partialTailLength(full.subarray(0, 3))).toBe(3);
    expect(partialTailLength(full)).toBe(0);
  });

  test("an empty buffer has no tail", () => {
    expect(partialTailLength(new Uint8Array())).toBe(0);
  });
});

describe("decodeText", () => {
  test("decodes and reports its line count", () => {
    const result = decodeText(utf8("one\ntwo\nthree"));
    expect(result.text).toBe("one\ntwo\nthree");
    expect(result.lineCount).toBe(3);
    expect(result.truncated).toBe(false);
  });

  test("strips a UTF-8 BOM", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("hi")]);
    expect(decodeText(bytes).text).toBe("hi");
  });

  test("normalises CRLF", () => {
    const result = decodeText(utf8("a\r\nb\r\n"));
    expect(result.text).toBe("a\nb\n");
  });

  test("a partial buffer drops the half character instead of rendering U+FFFD", () => {
    // This is the head-read case: the slice ends mid-emoji.
    const full = utf8("done 🎉");
    const cut = full.subarray(0, full.length - 2);
    const naive = new TextDecoder("utf-8").decode(cut);
    expect(naive).toContain("�");

    const result = decodeText(cut, { partial: true });
    expect(result.text).toBe("done ");
    expect(result.text).not.toContain("�");
    expect(result.truncated).toBe(true);
  });

  test("a complete partial buffer is not marked truncated", () => {
    const result = decodeText(utf8("clean"), { partial: true });
    expect(result.truncated).toBe(false);
  });

  test("caps bytes and reports truncation", () => {
    const result = decodeText(utf8("abcdefghij"), { maxBytes: 4 });
    expect(result.text).toBe("abcd");
    expect(result.truncated).toBe(true);
  });

  test("a byte cap that lands mid-character still trims cleanly", () => {
    const result = decodeText(utf8("ab🎉cd"), { maxBytes: 4 });
    expect(result.text).toBe("ab");
    expect(result.text).not.toContain("�");
    expect(result.truncated).toBe(true);
  });

  test("caps lines and reports truncation", () => {
    const source = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const result = decodeText(utf8(source), { maxLines: 10 });
    expect(result.lineCount).toBe(10);
    expect(result.text.split("\n")).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });

  test("an empty buffer decodes to nothing", () => {
    const result = decodeText(new Uint8Array());
    expect(result.text).toBe("");
    expect(result.lineCount).toBe(0);
  });
});
