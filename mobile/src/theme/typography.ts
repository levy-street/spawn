import { Platform } from "react-native";

export const fontFamily = {
  sans: Platform.select({ ios: "System", android: "sans-serif", default: "System" }) ?? "System",
  mono:
    Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) ?? "monospace",
  sigil:
    Platform.select({ ios: "SF Mono", android: "monospace", default: "monospace" }) ?? "monospace",
  grimoireRegular: "IBMPlexSans_400Regular",
  grimoireMedium: "IBMPlexSans_500Medium",
  posterLight: "Rowdies_300Light",
} as const;

export const fontWeight = {
  light: "300",
  normal: "400",
  medium: "500",
  semibold: "600",
} as const;

export const fontSize = {
  microIllustration: 8.5,
  tiny: 9,
  tinyPlus: 9.5,
  ten: 10,
  tenPlus: 10.5,
  micro: 11,
  xs: 12,
  terminal: 13,
  sm: 14,
  fifteen: 15,
  base: 16,
  seventeen: 17,
  lg: 18,
  xl: 20,
  displaySm: 24,
  displayMd: 26,
  displayLg: 28,
} as const;

export const lineHeight = {
  compact: 14,
  micro: 16,
  terminal: 15.6,
  sm: 20,
  base: 24,
  lg: 28,
  xl: 32,
  none: 1,
  tight: 1.25,
  snug: 1.375,
  normal: 1.5,
  relaxed: 1.625,
  loose: 2,
} as const;

export const displayLineHeightRatio = {
  posterTightest: 0.98,
  none: 1,
  r102: 1.02,
  r104: 1.04,
  r106: 1.06,
  r108: 1.08,
  r125: 1.25,
  r130: 1.3,
  r155: 1.55,
  r160: 1.6,
} as const;

export const letterSpacing = {
  tighterEm: -0.05,
  tightEm: -0.025,
  normalEm: 0,
  wideEm: 0.025,
  sigil04Em: 0.04,
  sigil10Em: 0.1,
  sigil12Em: 0.12,
  sigil14Em: 0.14,
  sigil16Em: 0.16,
  sigil18Em: 0.18,
  sigil22Em: 0.22,
  sigil30Em: 0.3,
} as const;

export const typeStyles = {
  uiXs: { fontSize: 12, lineHeight: 16, fontWeight: "400" },
  uiSm: { fontSize: 14, lineHeight: 20, fontWeight: "400" },
  uiSmMedium: { fontSize: 14, lineHeight: 20, fontWeight: "500" },
  uiSmSemibold: { fontSize: 14, lineHeight: 20, fontWeight: "600" },
  uiBase: { fontSize: 16, lineHeight: 24, fontWeight: "400" },
  cardTitle: { fontSize: 16, lineHeight: 20, fontWeight: "600", letterSpacing: 0 },
  micro: { fontSize: 11, lineHeight: 16, fontWeight: "500" },
  sigilLabel: {
    fontFamily: fontFamily.sigil,
    fontSize: 11,
    lineHeight: 16,
    fontWeight: "500",
    letterSpacing: 1.76,
    textTransform: "uppercase",
  },
  sigilButton: {
    fontFamily: fontFamily.sigil,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "500",
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  terminal: {
    fontFamily: fontFamily.mono,
    fontSize: 13,
    lineHeight: 15.6,
    fontWeight: "400",
    letterSpacing: 0,
  },
} as const;

export const displayClamp = {
  c17_2_21: [17, 2, 21],
  c24_3_7_35: [24, 3.7, 35],
  c24_3_7_41: [24, 3.7, 41],
  c26_3_5_39: [26, 3.5, 39],
  c26_4_5_48: [26, 4.5, 48],
  c26_5_9_32: [26, 5.9, 32],
  c28_3_7_48: [28, 3.7, 48],
  c30_4_5_48: [30, 4.5, 48],
  c30_4_8_52: [30, 4.8, 52],
  c30_5_4_48: [30, 5.4, 48],
  c32_4_3_63: [32, 4.3, 63],
  c32_4_8_60: [32, 4.8, 60],
  c32_5_6_63: [32, 5.6, 63],
  c35_5_6_63: [35, 5.6, 63],
  c36_6_9_65: [36, 6.9, 65],
  c40_7_5_92: [40, 7.5, 92],
} as const;

/** Match CSS clamp(minPx, vw, maxPx) for brand-only display blocks. */
export function clampDisplay(
  widthPx: number,
  minPx: number,
  viewportWidthPercent: number,
  maxPx: number,
): number {
  return Math.min(maxPx, Math.max(minPx, (widthPx * viewportWidthPercent) / 100));
}

export const typography = {
  fontFamily,
  fontWeight,
  fontSize,
  lineHeight,
  displayLineHeightRatio,
  letterSpacing,
  typeStyles,
  displayClamp,
  clampDisplay,
} as const;

export type Typography = typeof typography;
