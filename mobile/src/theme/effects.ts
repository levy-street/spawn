export const shadow = {
  sm: "0 1px 3px 0 rgba(0,0,0,0.10), 0 1px 2px -1px rgba(0,0,0,0.10)",
  md: "0 4px 6px -1px rgba(0,0,0,0.10), 0 2px 4px -2px rgba(0,0,0,0.10)",
  lg: "0 10px 15px -3px rgba(0,0,0,0.10), 0 4px 6px -4px rgba(0,0,0,0.10)",
  xl: "0 20px 25px -5px rgba(0,0,0,0.10), 0 8px 10px -6px rgba(0,0,0,0.10)",
  xxl: "0 25px 50px -12px rgba(0,0,0,0.25)",
  dialogLight: "0 25px 50px -12px rgba(0,0,0,0.20)",
  dialogDark: "0 25px 50px -12px rgba(0,0,0,0.50)",
} as const;

export const blurRadius = {
  drag: 1,
  modal: 2,
  sm: 8,
  base: 8,
  md: 12,
} as const;

export const opacity = {
  hidden: 0,
  quiet: 0.45,
  /** The rule that spends a toast's life: present, never loud. */
  countdown: 0.55,
  disabled: 0.5,
  pulse: 0.6,
  skeleton: 0.7,
  hoverButton: 0.9,
  /** A pressed control that dims its own content instead of tinting its ground. */
  pressedContent: 0.8,
  opaque: 1,
} as const;

/**
 * A theme colour at a given alpha.
 *
 * Gradient stops need the fade in the channel rather than on the view: an
 * `opacity` here would take the whole ramp down with it, and a stop written as
 * `"transparent"` fades through black on the way, which shows as a bruise on a
 * light ground. Hex and `rgb()`/`rgba()` tokens are understood; anything else
 * comes back untouched rather than mangled.
 */
export function withAlpha(color: string, value: number): string {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (hex) {
    const channels = Number.parseInt(hex[1] as string, 16);
    return `rgba(${(channels >> 16) & 255},${(channels >> 8) & 255},${channels & 255},${value})`;
  }
  const rgb = /^rgba?\(([^)]*)\)$/.exec(color);
  if (rgb) {
    const [red = "0", green = "0", blue = "0"] = (rgb[1] as string).split(",");
    return `rgba(${red.trim()},${green.trim()},${blue.trim()},${value})`;
  }
  return color;
}

/** Apply these to a color channel rather than to an entire subtree. */
export const alpha = {
  a05: 0.05,
  a08: 0.08,
  a10: 0.1,
  a12: 0.12,
  a13: 0.13,
  a14: 0.14,
  a15: 0.15,
  a20: 0.2,
  a25: 0.25,
  a26: 0.26,
  a30: 0.3,
  a35: 0.35,
  a40: 0.4,
  a45: 0.45,
  a50: 0.5,
  a55: 0.55,
  a60: 0.6,
  a70: 0.7,
  a75: 0.75,
  a80: 0.8,
  a85: 0.85,
  a90: 0.9,
  a95: 0.95,
} as const;

export const layer = {
  decorativeBack: -10,
  base: 0,
  predictiveEcho: 5,
  connecting: 6,
  tile: 10,
  paneOverlay: 20,
  mobileChrome: 30,
  floatingChrome: 40,
  modal: 50,
  tooltip: 60,
  previewPopover: 90,
  menu: 100,
  launcherDropPreview: 105,
  launcherDragGhost: 110,
  toast: 120,
} as const;
