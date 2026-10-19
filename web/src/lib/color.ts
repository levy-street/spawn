/**
 * Colour arithmetic for the few places a person picks a colour — a tab group's
 * custom colour — and the text that has to sit on it. Hex is what is stored
 * (lowercase `#rrggbb`); HSV is what the picker is shaped like, a hue strip
 * beside a saturation/brightness square.
 */

/** Hue in degrees [0, 360), saturation and value in [0, 1]. */
export interface Hsv {
  h: number;
  s: number;
  v: number;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** The two label inks a coloured pill can wear. Dark is the light theme's
 *  foreground, not pure black, so a label reads as text rather than a hole. */
export const LABEL_TEXT_DARK = "#171717";
export const LABEL_TEXT_LIGHT = "#ffffff";

/**
 * What a person typed, as the stored form: `#rgb` or `#rrggbb`, any case,
 * surrounding space forgiven, comes back as lowercase `#rrggbb`; anything
 * else is null. The hash is required — "abc" is as likely a word as a colour.
 */
export function parseHex(input: string): string | null {
  const value = input.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/iu.exec(value);
  if (short) {
    const [, r, g, b] = short as unknown as [string, string, string, string];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return /^#[0-9a-f]{6}$/iu.test(value) ? value.toLowerCase() : null;
}

export function hexToRgb(hex: string): Rgb | null {
  const parsed = parseHex(hex);
  if (!parsed) return null;
  return {
    r: Number.parseInt(parsed.slice(1, 3), 16),
    g: Number.parseInt(parsed.slice(3, 5), 16),
    b: Number.parseInt(parsed.slice(5, 7), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const channel = (value: number) =>
    Math.round(Math.min(255, Math.max(0, value)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const hue = (((h % 360) + 360) % 360) / 60;
  const chroma = v * s;
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  const m = v - chroma;
  const [r, g, b] =
    hue < 1
      ? [chroma, x, 0]
      : hue < 2
        ? [x, chroma, 0]
        : hue < 3
          ? [0, chroma, x]
          : hue < 4
            ? [0, x, chroma]
            : hue < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const [red, green, blue] = [r / 255, g / 255, b / 255];
  const max = Math.max(red, green, blue);
  const delta = max - Math.min(red, green, blue);
  let h = 0;
  if (delta > 0) {
    if (max === red) h = ((green - blue) / delta) % 6;
    else if (max === green) h = (blue - red) / delta + 2;
    else h = (red - green) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToHex(hsv: Hsv): string {
  return rgbToHex(hsvToRgb(hsv));
}

/** Null for anything `parseHex` refuses. A grey answers hue 0 — the picker
 *  keeps the hue it already had rather than ask this. */
export function hexToHsv(hex: string): Hsv | null {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToHsv(rgb) : null;
}

/** WCAG 2 relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b);
}

/** WCAG 2 contrast ratio between two colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * The label ink for text on `hex`: whichever of the dark and light inks has
 * the higher contrast against it. Mid-tones are where the two are close, and
 * the ratio, not a luminance cut-off, is what decides those honestly.
 */
export function labelTextColor(hex: string): string {
  return contrastRatio(hex, LABEL_TEXT_DARK) >= contrastRatio(hex, LABEL_TEXT_LIGHT)
    ? LABEL_TEXT_DARK
    : LABEL_TEXT_LIGHT;
}
