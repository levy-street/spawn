import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  contrastRatio,
  hexToHsv,
  hexToRgb,
  hsvToHex,
  LABEL_TEXT_DARK,
  LABEL_TEXT_LIGHT,
  labelTextColor,
  parseHex,
  relativeLuminance,
  rgbToHex,
} from "./color";
import { PRESET_COLORS } from "./tab-groups";

describe("parseHex", () => {
  test("widens #rgb and lowercases #rrggbb", () => {
    expect(parseHex("#0af")).toBe("#00aaff");
    expect(parseHex("#0AF")).toBe("#00aaff");
    expect(parseHex("#A1B2C3")).toBe("#a1b2c3");
    expect(parseHex("  #a1b2c3 ")).toBe("#a1b2c3");
  });

  test("refuses anything else", () => {
    for (const input of ["", "#", "a1b2c3", "#abcd", "#12345g", "#a1b2c3ff", "blue", "#ab"]) {
      expect(parseHex(input)).toBeNull();
    }
  });
});

describe("hex and HSV", () => {
  test("the primaries and greys land where they should", () => {
    expect(hexToHsv("#ff0000")).toEqual({ h: 0, s: 1, v: 1 });
    expect(hexToHsv("#00ff00")).toEqual({ h: 120, s: 1, v: 1 });
    expect(hexToHsv("#0000ff")).toEqual({ h: 240, s: 1, v: 1 });
    expect(hexToHsv("#000000")).toEqual({ h: 0, s: 0, v: 0 });
    expect(hexToHsv("#ffffff")).toEqual({ h: 0, s: 0, v: 1 });
    expect(hsvToHex({ h: 60, s: 1, v: 1 })).toBe("#ffff00");
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe("#ff0000");
    expect(hsvToHex({ h: 0, s: 0, v: 0.5 })).toBe("#808080");
  });

  test("every hex survives the round trip through HSV", () => {
    for (let value = 0; value < 0xffffff; value += 0x0f0e0d) {
      const hex = `#${value.toString(16).padStart(6, "0")}`;
      const hsv = hexToHsv(hex);
      expect(hsv).not.toBeNull();
      expect(hsvToHex(hsv as NonNullable<typeof hsv>)).toBe(hex);
    }
  });

  test("rgb clamps and pads", () => {
    expect(rgbToHex({ r: -4, g: 300, b: 7.6 })).toBe("#00ff08");
    expect(hexToRgb("#0af")).toEqual({ r: 0, g: 170, b: 255 });
    expect(hexToRgb("nope")).toBeNull();
  });
});

describe("label ink", () => {
  test("luminance and contrast match WCAG's anchors", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 6);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 6);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 6);
  });

  test("picks whichever ink has more contrast", () => {
    expect(labelTextColor("#ffff00")).toBe(LABEL_TEXT_DARK);
    expect(labelTextColor("#000080")).toBe(LABEL_TEXT_LIGHT);
    for (const hex of ["#2f6fe4", "#a47a06", "#808080", "#3ccbe3", "#d93030"]) {
      const chosen = labelTextColor(hex);
      const other = chosen === LABEL_TEXT_DARK ? LABEL_TEXT_LIGHT : LABEL_TEXT_DARK;
      expect(contrastRatio(hex, chosen)).toBeGreaterThanOrEqual(contrastRatio(hex, other));
    }
  });

  // The preset tokens are hand-written in the stylesheet, one pair per theme;
  // this keeps every pill's ink the one labelTextColor would have chosen, so
  // a retuned colour cannot leave its label unreadable.
  test("every theme's preset tokens wear the ink labelTextColor picks", () => {
    const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
    const blocks = [/:root \{([\s\S]*?)\n\}/u, /\[data-theme="dark"\] \{([\s\S]*?)\n\}/u].map(
      (pattern) => pattern.exec(css)?.[1] ?? "",
    );
    for (const block of blocks) {
      for (const preset of PRESET_COLORS) {
        const fill = new RegExp(`--tab-group-${preset}: (#[0-9a-f]{6});`, "u").exec(block)?.[1];
        const ink = new RegExp(`--tab-group-${preset}-fg: (#[0-9a-f]{6});`, "u").exec(block)?.[1];
        expect(fill, preset).toBeDefined();
        expect(ink, preset).toBe(labelTextColor(fill as string));
        expect(contrastRatio(fill as string, ink as string)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
