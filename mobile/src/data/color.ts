/**
 * Colour arithmetic for custom tab group colours: reading what a person typed,
 * moving between hex and the hue/saturation/value the picker drags, and which
 * ink stays legible on a chip of that colour.
 */
import { darkColors, lightColors } from "@/theme/colors";

export interface Hsv {
  /** Degrees, 0 up to (not including) 360. */
  h: number;
  /** 0 to 1. */
  s: number;
  /** 0 to 1. */
  v: number;
}

const SHORT_HEX = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/;
const LONG_HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * What a person typed as a colour, as lowercase `#rrggbb`: `#rgb` and
 * `#rrggbb` in any case, surrounding space ignored. Null for anything else.
 */
export function parseHex(value: string): string | null {
  const text = value.trim();
  const short = SHORT_HEX.exec(text);
  if (short) {
    const [, r = "", g = "", b = ""] = short;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return LONG_HEX.test(text) ? text.toLowerCase() : null;
}

function channels(hex: string): [number, number, number] | null {
  const parsed = parseHex(hex);
  if (!parsed) return null;
  const value = Number.parseInt(parsed.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function toHexByte(value: number): string {
  return Math.round(clamp(value, 0, 255))
    .toString(16)
    .padStart(2, "0");
}

export function hexToHsv(hex: string): Hsv | null {
  const rgb = channels(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((channel) => channel / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta > 0) {
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }
  return { h: (h + 360) % 360, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const hue = ((h % 360) + 360) % 360;
  const saturation = clamp(s, 0, 1);
  const value = clamp(v, 0, 1);
  const chroma = value * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = value - chroma;
  const sector = Math.floor(hue / 60);
  const [r, g, b] =
    sector === 0
      ? [chroma, x, 0]
      : sector === 1
        ? [x, chroma, 0]
        : sector === 2
          ? [0, chroma, x]
          : sector === 3
            ? [0, x, chroma]
            : sector === 4
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return `#${toHexByte((r + m) * 255)}${toHexByte((g + m) * 255)}${toHexByte((b + m) * 255)}`;
}

/** WCAG 2 relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const rgb = channels(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio between two colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (lighter + 0.05) / (darker + 0.05);
}

export interface LabelInks {
  dark: string;
  light: string;
}

const DEFAULT_INKS: LabelInks = { dark: lightColors.foreground, light: darkColors.foreground };

/**
 * The ink a label on `background` is set in: whichever of the dark and light
 * foregrounds has the higher WCAG contrast against it.
 */
export function labelTextColor(background: string, inks: LabelInks = DEFAULT_INKS): string {
  return contrastRatio(background, inks.dark) >= contrastRatio(background, inks.light)
    ? inks.dark
    : inks.light;
}
