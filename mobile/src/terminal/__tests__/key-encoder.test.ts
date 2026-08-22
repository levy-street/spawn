import { encodeKey } from "@/terminal/key-encoder";
import type { KeySpec, NamedTerminalKey } from "@/terminal/transport/types";

function hex(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join(" ");
}

describe("encodeKey", () => {
  const namedCases: ReadonlyArray<[NamedTerminalKey, string]> = [
    ["Escape", "1b"],
    ["Tab", "09"],
    ["BackTab", "1b 5b 5a"],
    ["Enter", "0d"],
    ["ShiftEnter", "1b 0d"],
    ["MobileReturn", "1b 5b 32 30 30 7e 0a 1b 5b 32 30 31 7e"],
    ["Backspace", "7f"],
    ["ArrowUp", "1b 5b 41"],
    ["ArrowDown", "1b 5b 42"],
    ["ArrowRight", "1b 5b 43"],
    ["ArrowLeft", "1b 5b 44"],
    ["Home", "1b 5b 48"],
    ["End", "1b 5b 46"],
    ["Insert", "1b 5b 32 7e"],
    ["Delete", "1b 5b 33 7e"],
    ["PageUp", "1b 5b 35 7e"],
    ["PageDown", "1b 5b 36 7e"],
    ["F1", "1b 4f 50"],
    ["F2", "1b 4f 51"],
    ["F3", "1b 4f 52"],
    ["F4", "1b 4f 53"],
    ["F5", "1b 5b 31 35 7e"],
    ["F6", "1b 5b 31 37 7e"],
    ["F7", "1b 5b 31 38 7e"],
    ["F8", "1b 5b 31 39 7e"],
    ["F9", "1b 5b 32 30 7e"],
    ["F10", "1b 5b 32 31 7e"],
    ["F11", "1b 5b 32 33 7e"],
    ["F12", "1b 5b 32 34 7e"],
  ];

  test.each(namedCases)("encodes %s", (key, expected) => {
    expect(hex(encodeKey({ kind: "named", key }))).toBe(expected);
  });

  test.each([
    ["ArrowUp", "1b 4f 41"],
    ["ArrowDown", "1b 4f 42"],
    ["ArrowRight", "1b 4f 43"],
    ["ArrowLeft", "1b 4f 44"],
    ["Home", "1b 4f 48"],
    ["End", "1b 4f 46"],
  ] as const)("uses application cursor sequence for %s", (key, expected) => {
    expect(hex(encodeKey({ kind: "named", key, applicationCursor: true }))).toBe(expected);
  });

  test.each(Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index)))(
    "encodes Ctrl-%s",
    (letter) => {
      expect(
        hex(encodeKey({ kind: "text", text: letter.toLowerCase(), modifiers: { ctrl: true } })),
      ).toBe((letter.charCodeAt(0) & 0x1f).toString(16).padStart(2, "0"));
    },
  );

  test.each([
    [" ", "00"],
    ["@", "00"],
    ["[", "1b"],
    ["\\", "1c"],
    ["]", "1d"],
    ["^", "1e"],
    ["_", "1f"],
    ["?", "7f"],
  ])("encodes Ctrl-%s", (text, expected) => {
    expect(hex(encodeKey({ kind: "text", text, modifiers: { ctrl: true } }))).toBe(expected);
  });

  test.each([
    [{ shift: true }, "1b 5b 31 3b 32 41"],
    [{ alt: true }, "1b 5b 31 3b 33 41"],
    [{ shift: true, alt: true }, "1b 5b 31 3b 34 41"],
    [{ ctrl: true }, "1b 5b 31 3b 35 41"],
    [{ shift: true, ctrl: true }, "1b 5b 31 3b 36 41"],
    [{ alt: true, ctrl: true }, "1b 5b 31 3b 37 41"],
    [{ shift: true, alt: true, ctrl: true }, "1b 5b 31 3b 38 41"],
  ] as const)("encodes modified Up", (modifiers, expected) => {
    const key: KeySpec = { kind: "named", key: "ArrowUp", modifiers };
    expect(hex(encodeKey(key))).toBe(expected);
  });

  test("prefixes Alt exactly once and applies Ctrl before Alt", () => {
    expect(hex(encodeKey({ kind: "text", text: "b", modifiers: { alt: true } }))).toBe("1b 62");
    expect(hex(encodeKey({ kind: "text", text: "c", modifiers: { ctrl: true, alt: true } }))).toBe(
      "1b 03",
    );
    expect(hex(encodeKey({ kind: "named", key: "Backspace", modifiers: { alt: true } }))).toBe(
      "1b 7f",
    );
  });

  test.each(["|", "/", "-", "~", "\\"])("passes literal %s", (text) => {
    expect(encodeKey({ kind: "text", text })).toBe(text);
  });

  test("preserves committed Unicode and empty text", () => {
    expect(encodeKey({ kind: "text", text: "猫🚀" })).toBe("猫🚀");
    expect(encodeKey({ kind: "text", text: "" })).toBe("");
  });
});
