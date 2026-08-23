"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_RANGE,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_LINE_HEIGHT_RANGE,
  TERMINAL_THEME_AUTO,
  terminalFontOptionById,
  terminalThemeById,
} from "@/components/terminal/xterm-config.mjs";
import { DARK_QUERY, THEME_STORAGE_KEY } from "./theme-bootstrap";

export { THEME_STORAGE_KEY };

/**
 * Terminal appearance lives beside the app theme rather than in
 * `xterm-config.mjs`, which must stay plain dependency-free `.mjs` because
 * the conformance SUT imports it. The config owns the *definitions*; this
 * store owns the *choice*.
 */
export const TERMINAL_APPEARANCE_STORAGE_KEY = "spawn.terminal.appearance";

export type TerminalAppearance = {
  /** A theme id, or "auto" to follow the app's light/dark. */
  themeId: string;
  /** A font option id from TERMINAL_FONT_OPTIONS. */
  fontId: string;
  fontSize: number;
  lineHeight: number;
};

export const DEFAULT_TERMINAL_APPEARANCE: TerminalAppearance = Object.freeze({
  themeId: TERMINAL_THEME_AUTO,
  fontId: "system",
  fontSize: TERMINAL_FONT_SIZE,
  lineHeight: TERMINAL_LINE_HEIGHT,
});

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Anything stored is attacker-adjacent only in the sense that it is old, or
 * hand-edited, or from a build that offered a theme this one does not. Every
 * field falls back rather than rendering an unreadable terminal.
 */
export function normalizeTerminalAppearance(value: unknown): TerminalAppearance {
  const raw = (value ?? {}) as Partial<Record<keyof TerminalAppearance, unknown>>;
  const themeId =
    typeof raw.themeId === "string" &&
    (raw.themeId === TERMINAL_THEME_AUTO || terminalThemeById(raw.themeId))
      ? raw.themeId
      : DEFAULT_TERMINAL_APPEARANCE.themeId;
  const fontId =
    typeof raw.fontId === "string" && terminalFontOptionById(raw.fontId)
      ? raw.fontId
      : DEFAULT_TERMINAL_APPEARANCE.fontId;
  const fontSize = Number(raw.fontSize);
  const lineHeight = Number(raw.lineHeight);
  return {
    themeId,
    fontId,
    fontSize: Number.isFinite(fontSize)
      ? clamp(Math.round(fontSize), TERMINAL_FONT_SIZE_RANGE.min, TERMINAL_FONT_SIZE_RANGE.max)
      : DEFAULT_TERMINAL_APPEARANCE.fontSize,
    lineHeight: Number.isFinite(lineHeight)
      ? clamp(
          Math.round(lineHeight * 100) / 100,
          TERMINAL_LINE_HEIGHT_RANGE.min,
          TERMINAL_LINE_HEIGHT_RANGE.max,
        )
      : DEFAULT_TERMINAL_APPEARANCE.lineHeight,
  };
}

/**
 * Theme preference: what the user chose. "system" defers to the OS, which is
 * the default — the OS already knows, so asking again on first visit is a
 * question we can answer ourselves.
 */
export type ThemePreference = "light" | "dark" | "system";

/** What that resolves to once the OS is consulted. Only ever light or dark. */
export type ResolvedTheme = "light" | "dark";

/** Matches --background in globals.css; drives the browser UI colour. */
const THEME_COLOR: Record<ResolvedTheme, string> = {
  light: "#fafafa",
  dark: "#070707",
};

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

export function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

export function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    // Private browsing and blocked storage both throw; the OS preference is
    // a perfectly good answer, so this is not worth surfacing.
    return "system";
  }
}

/**
 * Stamp the resolved theme onto <html>.
 *
 * `data-theme` is what globals.css keys off, and `color-scheme` is what makes
 * the browser paint its own furniture — form controls, the scrollbar gutter,
 * the canvas behind an overscroll — to match. Setting only the first leaves
 * white flashes at the edges of a dark page.
 */
export function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLOR[resolved]);
}

// --- store -----------------------------------------------------------------
// A tiny external store rather than context: the terminal reads the resolved
// theme from outside the React tree it is portaled into, and settings writes
// it from a dialog that is not an ancestor of anything it affects.

const listeners = new Set<() => void>();
let preference: ThemePreference = "system";
// One store and one listener set for both, so the terminal — which subscribes
// from outside React — gets app-theme and terminal-appearance changes through
// exactly the same path it already had.
let terminalAppearance: TerminalAppearance = DEFAULT_TERMINAL_APPEARANCE;
let initialised = false;

function emit(): void {
  for (const listener of listeners) listener();
}

function ensureInitialised(): void {
  if (initialised || typeof window === "undefined") return;
  initialised = true;
  preference = readStoredPreference();
  terminalAppearance = readStoredTerminalAppearance();
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener("change", () => {
    // Only a "system" preference tracks the OS, but the listener stays
    // attached either way so switching back to "system" is instant.
    if (preference === "system") {
      applyTheme(systemTheme());
      emit();
    }
  });
}

function subscribe(listener: () => void): () => void {
  ensureInitialised();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getThemePreference(): ThemePreference {
  ensureInitialised();
  return preference;
}

export function getResolvedTheme(): ResolvedTheme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function setThemePreference(next: ThemePreference): void {
  ensureInitialised();
  preference = next;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Storage refused; the choice still applies for this session.
  }
  applyTheme(resolveTheme(next));
  emit();
}

/** Subscribe to theme changes outside React (the terminal does this). */
export function subscribeToTheme(listener: () => void): () => void {
  return subscribe(listener);
}

function readStoredTerminalAppearance(): TerminalAppearance {
  if (typeof window === "undefined") return DEFAULT_TERMINAL_APPEARANCE;
  try {
    const stored = window.localStorage.getItem(TERMINAL_APPEARANCE_STORAGE_KEY);
    return normalizeTerminalAppearance(stored ? JSON.parse(stored) : null);
  } catch {
    // Blocked storage and malformed JSON are both "use the defaults".
    return DEFAULT_TERMINAL_APPEARANCE;
  }
}

export function getTerminalAppearance(): TerminalAppearance {
  ensureInitialised();
  return terminalAppearance;
}

export function setTerminalAppearance(next: Partial<TerminalAppearance>): void {
  ensureInitialised();
  terminalAppearance = normalizeTerminalAppearance({ ...terminalAppearance, ...next });
  try {
    window.localStorage.setItem(
      TERMINAL_APPEARANCE_STORAGE_KEY,
      JSON.stringify(terminalAppearance),
    );
  } catch {
    // Storage refused; the choice still applies for this session.
  }
  emit();
}

export function useTerminalAppearance(): {
  appearance: TerminalAppearance;
  setAppearance: (next: Partial<TerminalAppearance>) => void;
} {
  const appearance = useSyncExternalStore(
    subscribe,
    getTerminalAppearance,
    () => DEFAULT_TERMINAL_APPEARANCE,
  );
  const setAppearance = useCallback(
    (next: Partial<TerminalAppearance>) => setTerminalAppearance(next),
    [],
  );
  return useMemo(() => ({ appearance, setAppearance }), [appearance, setAppearance]);
}

export function useTheme(): {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
} {
  const pref = useSyncExternalStore(subscribe, getThemePreference, () => "system" as const);
  const resolved = useSyncExternalStore(subscribe, getResolvedTheme, () => "dark" as const);

  // The bootstrap script already stamped <html>, but it cannot reach the
  // theme-color meta tag, which Next renders after the script runs.
  useEffect(() => {
    applyTheme(getResolvedTheme());
  }, []);

  const setPreference = useCallback((next: ThemePreference) => setThemePreference(next), []);
  return useMemo(
    () => ({ preference: pref, resolved, setPreference }),
    [pref, resolved, setPreference],
  );
}
