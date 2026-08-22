import { sizing } from "./sizing";

export const spacing = {
  0: 0,
  px: 1,
  "0.5": 2,
  1: 4,
  "1.5": 6,
  2: 8,
  "2.5": 10,
  3: 12,
  "3.5": 14,
  4: 16,
  5: 20,
  6: 24,
  "6.5": 26,
  7: 28,
  8: 32,
  9: 36,
  10: 40,
  11: 44,
  12: 48,
  14: 56,
  16: 64,
  20: 80,
  24: 96,
  32: 128,
} as const;

export function space(units: number): number {
  return units * sizing.space.unit;
}

export const radii = {
  sm: 6,
  md: 8,
  lg: 10,
  xl: 12,
  xxl: 16,
  pill: 9999,
} as const;

export const radius = {
  xxs: 2,
  raw: 4,
  sm: radii.sm,
  md: radii.md,
  lg: radii.lg,
  xl: radii.xl,
  xxl: radii.xxl,
  full: radii.pill,
} as const;

export const specialSpace = {
  threePx: 3,
  ctaVertical: 15,
  paneHalfGap: 3,
} as const;

export const borderWidth = {
  none: 0,
  hairline: 1,
  emphasis: 2,
  poster: 4,
} as const;

export const chrome = {
  sidebarWidth: 264,
  sidebarRailWidth: 56,
  rowHeight: sizing.listRow.regular,
  paneGap: sizing.space.peer,
  contentInsetMobile: sizing.screen.gutter,
  contentInsetDesktop: sizing.screen.regularWidthGutter,
  touchTarget: sizing.control.minimumTouchTarget,
  terminalPaddingHorizontal: 6,
  terminalPaddingVertical: 4,
  menuViewportMargin: 8,
  menuAnchorOffset: 4,
  pickerColumnWidth: 224,
  pickerPreferredWidth: 474,
  pickerPreferredHeight: 440,
  gridUnits: 24,
  drawerMaxWidth: 264,
  drawerWidthFraction: 0.85,
  sheetTopClearance: 40,
} as const;
