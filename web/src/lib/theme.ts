"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { DARK_QUERY, THEME_STORAGE_KEY } from "./theme-bootstrap";

export { THEME_STORAGE_KEY };

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
let initialised = false;

function emit(): void {
  for (const listener of listeners) listener();
}

function ensureInitialised(): void {
  if (initialised || typeof window === "undefined") return;
  initialised = true;
  preference = readStoredPreference();
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
