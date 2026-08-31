import { describe, expect, test } from "bun:test";
import {
  appleArrowBytes,
  type Chord,
  gridShortcut,
  keystrokeBelongsToText,
  usesAppleModifiers,
} from "./keyboard-chords";

function chord(overrides: Partial<Chord> & Pick<Chord, "key">): Chord {
  return {
    code: overrides.key.startsWith("Arrow") ? overrides.key : "",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

const inText = { textHasKey: true };
const inCanvas = { textHasKey: false };

describe("which keyboards put ⌥ in the shell's hands", () => {
  test("Apple's do, phone and desktop alike", () => {
    expect(usesAppleModifiers("macos")).toBe(true);
    expect(usesAppleModifiers("ios")).toBe(true);
  });

  test("nobody else's does", () => {
    expect(usesAppleModifiers("windows")).toBe(false);
    expect(usesAppleModifiers("linux")).toBe(false);
    expect(usesAppleModifiers("android")).toBe(false);
    expect(usesAppleModifiers("unknown")).toBe(false);
  });
});

describe("the grid's chords on a Mac", () => {
  const apple = true;

  test("bare ⌥+Arrow is the shell's word key wherever a terminal is listening", () => {
    expect(
      gridShortcut(chord({ key: "ArrowLeft", altKey: true }), { apple, ...inText }),
    ).toBeNull();
    expect(
      gridShortcut(chord({ key: "ArrowRight", altKey: true }), { apple, ...inText }),
    ).toBeNull();
  });

  test("bare ⌥+Arrow still moves the focus where nothing is typing", () => {
    expect(
      gridShortcut(chord({ key: "ArrowRight", altKey: true }), { apple, ...inCanvas }),
    ).toEqual({ kind: "focus", forward: true });
  });

  test("⌥+digit stays the app's, terminal or not — no shell wants it", () => {
    expect(
      gridShortcut(chord({ key: "£", code: "Digit3", altKey: true }), { apple, ...inText }),
    ).toEqual({ kind: "workspace", position: 3 });
  });

  test("⌃⌥ and ⌘⌥ reach the app from inside a terminal", () => {
    for (const held of [{ ctrlKey: true }, { metaKey: true }]) {
      expect(
        gridShortcut(chord({ key: "ArrowLeft", altKey: true, ...held }), { apple, ...inText }),
      ).toEqual({ kind: "focus", forward: false });
      expect(
        gridShortcut(chord({ key: "ArrowDown", altKey: true, ...held }), { apple, ...inText }),
      ).toEqual({ kind: "focus", forward: true });
      expect(
        gridShortcut(chord({ key: "2", code: "Digit2", altKey: true, ...held }), {
          apple,
          ...inText,
        }),
      ).toEqual({ kind: "workspace", position: 2 });
    }
  });

  test("⌃⌘⌥ is nobody's chord", () => {
    expect(
      gridShortcut(chord({ key: "ArrowLeft", altKey: true, ctrlKey: true, metaKey: true }), {
        apple,
        ...inCanvas,
      }),
    ).toBeNull();
  });
});

describe("the grid's chords everywhere else", () => {
  const apple = false;

  test("Alt+Arrow stays the pane chord it is in Windows Terminal, terminal or not", () => {
    expect(gridShortcut(chord({ key: "ArrowRight", altKey: true }), { apple, ...inText })).toEqual({
      kind: "focus",
      forward: true,
    });
    expect(gridShortcut(chord({ key: "ArrowUp", altKey: true }), { apple, ...inText })).toEqual({
      kind: "focus",
      forward: false,
    });
  });

  test("Ctrl+Arrow is the shell's word key and never the app's", () => {
    expect(
      gridShortcut(chord({ key: "ArrowLeft", ctrlKey: true }), { apple, ...inText }),
    ).toBeNull();
    expect(
      gridShortcut(chord({ key: "ArrowLeft", altKey: true, ctrlKey: true }), { apple, ...inText }),
    ).toBeNull();
  });

  test("Alt+digit switches workspace by position", () => {
    expect(
      gridShortcut(chord({ key: "9", code: "Digit9", altKey: true }), { apple, ...inText }),
    ).toEqual({ kind: "workspace", position: 9 });
    expect(
      gridShortcut(chord({ key: "0", code: "Digit0", altKey: true }), { apple, ...inText }),
    ).toBeNull();
  });
});

describe("chords the grid never claims", () => {
  test("Alt+Shift+Arrow belongs to the tab strip", () => {
    for (const apple of [true, false]) {
      expect(
        gridShortcut(chord({ key: "ArrowLeft", altKey: true, shiftKey: true }), {
          apple,
          ...inCanvas,
        }),
      ).toBeNull();
    }
  });

  test("an unmodified arrow is the shell's", () => {
    for (const apple of [true, false]) {
      expect(gridShortcut(chord({ key: "ArrowLeft" }), { apple, ...inCanvas })).toBeNull();
    }
  });
});

describe("the Mac arrows the terminal states for itself", () => {
  test("⌥ moves a word — the spelling every shell binds", () => {
    expect(appleArrowBytes(chord({ key: "ArrowLeft", altKey: true }))).toBe("\x1bb");
    expect(appleArrowBytes(chord({ key: "ArrowRight", altKey: true }))).toBe("\x1bf");
  });

  test("⌘ reaches the ends of the line", () => {
    expect(appleArrowBytes(chord({ key: "ArrowLeft", metaKey: true }))).toBe("\x01");
    expect(appleArrowBytes(chord({ key: "ArrowRight", metaKey: true }))).toBe("\x05");
  });

  test("it yields the moment the chord becomes the grid's", () => {
    expect(appleArrowBytes(chord({ key: "ArrowLeft", metaKey: true, altKey: true }))).toBeNull();
    expect(appleArrowBytes(chord({ key: "ArrowLeft", altKey: true, ctrlKey: true }))).toBeNull();
    expect(appleArrowBytes(chord({ key: "ArrowLeft", altKey: true, shiftKey: true }))).toBeNull();
  });

  test("the vertical arrows and a bare one are left to xterm", () => {
    expect(appleArrowBytes(chord({ key: "ArrowUp", metaKey: true }))).toBeNull();
    expect(appleArrowBytes(chord({ key: "ArrowUp", altKey: true }))).toBeNull();
    expect(appleArrowBytes(chord({ key: "ArrowDown", altKey: true }))).toBeNull();
    expect(appleArrowBytes(chord({ key: "ArrowLeft" }))).toBeNull();
  });
});

describe("which targets are typing", () => {
  test("nothing outside the document is", () => {
    expect(keystrokeBelongsToText(null)).toBe(false);
  });
});
