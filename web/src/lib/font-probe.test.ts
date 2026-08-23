import { afterEach, describe, expect, test } from "bun:test";
import { isFontFamilyAvailable, resetFontProbe } from "./font-probe";

/**
 * Stand in for the canvas: `widths` maps a font shorthand substring to the
 * width it should measure, so a test can say "this family measures
 * differently from the fallbacks" without a real font.
 */
function stubCanvas(measure: (font: string) => number) {
  let font = "";
  const context = {
    get font() {
      return font;
    },
    set font(value: string) {
      font = value;
    },
    measureText: () => ({ width: measure(font) }),
  };
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ getContext: () => context }),
  };
  resetFontProbe();
}

afterEach(() => {
  (globalThis as unknown as { document?: unknown }).document = undefined;
  resetFontProbe();
});

describe("isFontFamilyAvailable", () => {
  test("a family that measures differently from every fallback is installed", () => {
    stubCanvas((font) => (font.includes("Hack Nerd Font") ? 500 : 400));
    expect(isFontFamilyAvailable("Hack Nerd Font")).toBe(true);
  });

  test("a missing family falls back, so the widths match exactly", () => {
    // This is what `document.fonts.check()` gets wrong: it would say yes.
    stubCanvas(() => 400);
    expect(isFontFamilyAvailable("Definitely Not Installed")).toBe(false);
  });

  test("matching one fallback by coincidence is not enough to be missing", () => {
    // Identical to monospace, different from serif -> present.
    stubCanvas((font) => {
      if (font.includes("serif") && !font.includes("sans-serif")) {
        return font.includes("Coincidence") ? 420 : 300;
      }
      return 400;
    });
    expect(isFontFamilyAvailable("Coincidence")).toBe(true);
  });

  test("a canvas that cannot measure reports nothing rather than guessing", () => {
    stubCanvas(() => 0);
    expect(isFontFamilyAvailable("Hack Nerd Font")).toBe(false);
  });

  test("no canvas at all is not a crash", () => {
    (globalThis as unknown as { document: unknown }).document = {
      createElement: () => ({ getContext: () => null }),
    };
    resetFontProbe();
    expect(isFontFamilyAvailable("Hack Nerd Font")).toBe(false);
  });
});
