import { type Colors, darkColors, lightColors } from "./colors";
import { type Motion, motion } from "./motion";
import { radii, space } from "./spacing";
import { type TerminalTheme, terminalDark, terminalLight } from "./terminal";
import { type Typography, typography } from "./typography";

export type ThemeMode = "light" | "dark" | "system";
export type ThemePreference = ThemeMode;
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "spawn.theme";

export interface Theme {
  isDark: boolean;
  colors: Colors;
  space: (units: number) => number;
  radii: typeof radii;
  type: Typography;
  motion: Motion;
  terminal: TerminalTheme;
}

export const themes: Record<ResolvedTheme, Colors> = {
  light: lightColors,
  dark: darkColors,
};

export const lightTheme = {
  isDark: false,
  colors: lightColors,
  space,
  radii,
  type: typography,
  motion,
  terminal: terminalLight,
} satisfies Theme;

export const darkTheme = {
  isDark: true,
  colors: darkColors,
  space,
  radii,
  type: typography,
  motion,
  terminal: terminalDark,
} satisfies Theme;

const appThemes: Record<ResolvedTheme, Theme> = {
  light: lightTheme,
  dark: darkTheme,
};

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

export const isThemePreference = isThemeMode;

export function resolveTheme(
  mode: ThemeMode,
  osScheme: "light" | "dark" | null | undefined,
): ResolvedTheme {
  return mode === "system" ? (osScheme === "light" ? "light" : "dark") : mode;
}

export function themeForMode(mode: ResolvedTheme): Theme {
  return appThemes[mode];
}
