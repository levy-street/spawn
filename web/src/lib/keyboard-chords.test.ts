import { describe, expect, test } from "bun:test";
import {
  appleArrowBytes,
  type Chord,
  explorerShortcut,
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

describe("the file browser's keys", () => {
  const mac = { apple: true, textHasKey: false };
  const pc = { apple: false, textHasKey: false };

  test("never while a rename box or the filter is typing", () => {
    expect(explorerShortcut(chord({ key: "ArrowDown" }), { ...mac, textHasKey: true })).toBeNull();
    expect(explorerShortcut(chord({ key: "a" }), { ...pc, textHasKey: true })).toBeNull();
  });

  test("never ⌥/Alt+Arrow — that is the grid's", () => {
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      expect(explorerShortcut(chord({ key, altKey: true }), mac)).toBeNull();
      expect(explorerShortcut(chord({ key, altKey: true }), pc)).toBeNull();
    }
  });

  test("never an AltGr character, even one that spells a chord", () => {
    // German AltGr+8 is "[": Ctrl+Alt on Windows, never "Back".
    expect(explorerShortcut(chord({ key: "[", ctrlKey: true, altKey: true }), pc)).toBeNull();
    expect(explorerShortcut(chord({ key: "@", ctrlKey: true, altKey: true }), pc)).toBeNull();
  });

  test("arrows move, Shift extends, Home and End jump", () => {
    expect(explorerShortcut(chord({ key: "ArrowDown" }), pc)).toEqual({
      kind: "move",
      to: "next",
      extend: false,
      keep: false,
    });
    expect(explorerShortcut(chord({ key: "ArrowUp", shiftKey: true }), mac)).toEqual({
      kind: "move",
      to: "prev",
      extend: true,
      keep: false,
    });
    expect(explorerShortcut(chord({ key: "End", shiftKey: true }), pc)).toMatchObject({
      to: "last",
      extend: true,
    });
    expect(explorerShortcut(chord({ key: "PageDown" }), mac)).toMatchObject({ to: "pageDown" });
  });

  test("Ctrl+Arrow moves only the focus on Windows and Linux; Ctrl+Space toggles", () => {
    expect(explorerShortcut(chord({ key: "ArrowDown", ctrlKey: true }), pc)).toEqual({
      kind: "move",
      to: "next",
      extend: false,
      keep: true,
    });
    expect(explorerShortcut(chord({ key: " ", ctrlKey: true }), pc)).toEqual({
      kind: "toggleSelected",
    });
    expect(explorerShortcut(chord({ key: " ", ctrlKey: true }), mac)).toBeNull();
  });

  test("← and → fold and unfold the tree", () => {
    expect(explorerShortcut(chord({ key: "ArrowLeft" }), mac)).toEqual({ kind: "collapse" });
    expect(explorerShortcut(chord({ key: "ArrowRight" }), pc)).toEqual({ kind: "expand" });
  });

  test("Return renames on a Mac; Enter opens elsewhere; F2 renames on both", () => {
    expect(explorerShortcut(chord({ key: "Enter" }), mac)).toEqual({ kind: "rename" });
    expect(explorerShortcut(chord({ key: "Enter" }), pc)).toEqual({ kind: "open" });
    expect(explorerShortcut(chord({ key: "F2" }), mac)).toEqual({ kind: "rename" });
    expect(explorerShortcut(chord({ key: "F2" }), pc)).toEqual({ kind: "rename" });
  });

  test("a Mac opens with ⌘↓ or ⌘O and goes up with ⌘↑", () => {
    expect(explorerShortcut(chord({ key: "ArrowDown", metaKey: true }), mac)).toEqual({
      kind: "open",
    });
    expect(explorerShortcut(chord({ key: "o", metaKey: true }), mac)).toEqual({ kind: "open" });
    expect(explorerShortcut(chord({ key: "ArrowUp", metaKey: true }), mac)).toEqual({ kind: "up" });
  });

  test("Backspace goes up on Windows and Linux, and deletes with ⌘ on a Mac", () => {
    expect(explorerShortcut(chord({ key: "Backspace" }), pc)).toEqual({ kind: "up" });
    expect(explorerShortcut(chord({ key: "Backspace" }), mac)).toBeNull();
    expect(explorerShortcut(chord({ key: "Backspace", metaKey: true }), mac)).toEqual({
      kind: "delete",
    });
    expect(explorerShortcut(chord({ key: "Backspace", metaKey: true, altKey: true }), mac)).toEqual(
      { kind: "delete" },
    );
    expect(explorerShortcut(chord({ key: "Delete" }), pc)).toEqual({ kind: "delete" });
    expect(explorerShortcut(chord({ key: "Delete", shiftKey: true }), pc)).toEqual({
      kind: "delete",
    });
  });

  test("Back and Forward are ⌘[ ⌘] and Ctrl+[ Ctrl+]", () => {
    expect(explorerShortcut(chord({ key: "[", metaKey: true }), mac)).toEqual({ kind: "back" });
    expect(explorerShortcut(chord({ key: "]", ctrlKey: true }), pc)).toEqual({ kind: "forward" });
    expect(explorerShortcut(chord({ key: "[", ctrlKey: true }), mac)).toBeNull();
  });

  test("the command chords use each platform's command key, and only it", () => {
    expect(explorerShortcut(chord({ key: "a", metaKey: true }), mac)).toEqual({
      kind: "selectAll",
    });
    expect(explorerShortcut(chord({ key: "a", ctrlKey: true }), pc)).toEqual({
      kind: "selectAll",
    });
    expect(explorerShortcut(chord({ key: "a", ctrlKey: true }), mac)).toBeNull();
    expect(explorerShortcut(chord({ key: "f", metaKey: true }), mac)).toEqual({ kind: "filter" });
    expect(explorerShortcut(chord({ key: "G", ctrlKey: true, shiftKey: true }), pc)).toEqual({
      kind: "goToFolder",
    });
    expect(explorerShortcut(chord({ key: "i", metaKey: true }), mac)).toEqual({ kind: "details" });
  });

  test("hidden files: ⇧⌘. on a Mac, Ctrl+H elsewhere", () => {
    expect(explorerShortcut(chord({ key: ">", metaKey: true, shiftKey: true }), mac)).toEqual({
      kind: "toggleHidden",
    });
    expect(explorerShortcut(chord({ key: ".", metaKey: true, shiftKey: true }), mac)).toEqual({
      kind: "toggleHidden",
    });
    expect(explorerShortcut(chord({ key: "h", ctrlKey: true }), pc)).toEqual({
      kind: "toggleHidden",
    });
  });

  test("New folder is bound only in the desktop app; a browser tab keeps ⇧⌘N", () => {
    const newFolder = chord({ key: "N", metaKey: true, shiftKey: true });
    expect(explorerShortcut(newFolder, mac)).toBeNull();
    expect(explorerShortcut(newFolder, { ...mac, desktopShell: true })).toEqual({
      kind: "newFolder",
    });
    expect(explorerShortcut(chord({ key: "n", metaKey: true }), mac)).toBeNull();
    expect(explorerShortcut(chord({ key: "t", ctrlKey: true }), pc)).toBeNull();
    expect(explorerShortcut(chord({ key: "w", ctrlKey: true }), pc)).toBeNull();
  });

  test("Space peeks and Escape clears", () => {
    expect(explorerShortcut(chord({ key: " " }), mac)).toEqual({ kind: "peek" });
    expect(explorerShortcut(chord({ key: "Escape" }), pc)).toEqual({ kind: "escape" });
  });

  test("typing letters is type-ahead, capitals included", () => {
    expect(explorerShortcut(chord({ key: "r" }), mac)).toEqual({ kind: "typeAhead", text: "r" });
    expect(explorerShortcut(chord({ key: "R", shiftKey: true }), pc)).toEqual({
      kind: "typeAhead",
      text: "R",
    });
    expect(explorerShortcut(chord({ key: "é" }), pc)).toEqual({ kind: "typeAhead", text: "é" });
    expect(explorerShortcut(chord({ key: "Tab" }), pc)).toBeNull();
    expect(explorerShortcut(chord({ key: "Shift", shiftKey: true }), pc)).toBeNull();
  });
});
