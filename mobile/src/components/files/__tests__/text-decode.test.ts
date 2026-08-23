import { PREVIEW_BUDGET } from "@/components/files/file-kinds";
import { decodeText, looksBinary, partialTailLength } from "@/components/files/text-decode";

const encoder = new TextEncoder();

describe("text decoding", () => {
  it("sniffs only the first 4096 bytes for NUL", () => {
    const bytes = new Uint8Array(5000).fill(65);
    bytes[4095] = 0;
    expect(looksBinary(bytes)).toBe(true);
    bytes[4095] = 65;
    bytes[4096] = 0;
    expect(looksBinary(bytes)).toBe(false);
  });

  test.each([
    [[0xe2], 1],
    [[0xe2, 0x82], 2],
    [[0xe2, 0x82, 0xac], 0],
    [[0x61, 0x62], 0],
  ])("detects an incomplete UTF-8 tail", (input, expected) => {
    expect(partialTailLength(Uint8Array.from(input))).toBe(expected);
  });

  it("strips BOM, normalizes CRLF, and removes a partial code point", () => {
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...encoder.encode("one\r\ntwo "), 0xe2, 0x82]);
    expect(decodeText(bytes, { partial: true })).toEqual({
      text: "one\ntwo ",
      truncated: true,
      lineCount: 2,
    });
  });

  it("caps decoded bytes at one MiB and lines at 5000", () => {
    const oversized = new Uint8Array(PREVIEW_BUDGET.textDecode + 1).fill(65);
    expect(decodeText(oversized, { maxBytes: PREVIEW_BUDGET.textDecode })).toMatchObject({
      truncated: true,
      text: expect.any(String),
    });
    const lines = encoder.encode(Array.from({ length: 5001 }, () => "x").join("\n"));
    expect(decodeText(lines, { maxLines: 5000 })).toMatchObject({
      truncated: true,
      lineCount: 5000,
    });
  });
});
