import {
  contrastRatio,
  hexToHsv,
  hsvToHex,
  labelTextColor,
  parseHex,
  relativeLuminance,
} from "@/data/color";
import { darkColors, lightColors } from "@/theme";

describe("parseHex", () => {
  it.each([
    ["#abc", "#aabbcc"],
    ["#ABC", "#aabbcc"],
    ["#A1b2C3", "#a1b2c3"],
    ["  #a1b2c3 ", "#a1b2c3"],
  ])("reads %j as %j", (input, expected) => {
    expect(parseHex(input)).toBe(expected);
  });

  it.each(["", "abc", "a1b2c3", "#abcd", "#12345g", "#a1b2c3ff", "blue"])("refuses %j", (input) => {
    expect(parseHex(input)).toBeNull();
  });
});

describe("hex and HSV", () => {
  it.each([
    ["#ff0000", { h: 0, s: 1, v: 1 }],
    ["#00ff00", { h: 120, s: 1, v: 1 }],
    ["#0000ff", { h: 240, s: 1, v: 1 }],
    ["#ffffff", { h: 0, s: 0, v: 1 }],
    ["#000000", { h: 0, s: 0, v: 0 }],
    ["#ff00ff", { h: 300, s: 1, v: 1 }],
  ])("reads %s", (hex, hsv) => {
    expect(hexToHsv(hex)).toEqual(hsv);
    expect(hsvToHex(hsv)).toBe(hex);
  });

  it("round-trips every colour it can name", () => {
    for (const hex of ["#1a2b3c", "#ff8800", "#00aaff", "#7f7f7f", "#123456", "#fedcba"]) {
      expect(hsvToHex(hexToHsv(hex) as NonNullable<ReturnType<typeof hexToHsv>>)).toBe(hex);
    }
  });

  it("wraps hue and clamps saturation and value", () => {
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe("#ff0000");
    expect(hsvToHex({ h: -120, s: 2, v: 2 })).toBe("#0000ff");
    expect(hsvToHex({ h: 60, s: -1, v: 0.5 })).toBe("#808080");
  });

  it("has no HSV for what is not a colour", () => {
    expect(hexToHsv("blue")).toBeNull();
  });
});

describe("label ink", () => {
  it("measures WCAG luminance and contrast", () => {
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1);
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("nope")).toBe(0);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21);
  });

  it("sets light grounds in the dark ink and dark grounds in the light one", () => {
    expect(labelTextColor("#ffd60a")).toBe(lightColors.foreground);
    expect(labelTextColor("#ffffff")).toBe(lightColors.foreground);
    expect(labelTextColor("#1d4ed8")).toBe(darkColors.foreground);
    expect(labelTextColor("#000000")).toBe(darkColors.foreground);
    expect(labelTextColor("#000000", { dark: "#111111", light: "#eeeeee" })).toBe("#eeeeee");
  });
});
