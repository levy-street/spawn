import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useColorScheme } from "react-native";

import {
  isThemeMode,
  resolveTheme,
  THEME_STORAGE_KEY,
  type Theme,
  type ThemeMode,
  themeForMode,
} from "./theme";

interface ThemeProviderValue {
  theme: Theme;
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeProviderValue | null>(null);

/**
 * Pins a subtree to one palette regardless of the device appearance. The auth
 * surface paints a fixed dark brand ground, so its controls must not follow the
 * OS into light mode — that renders near-black labels on a near-black card.
 * `grimoire` goes further and hands that subtree the press palette itself, so a
 * borrowed button or field arrives already inked rather than restyled in place.
 */
export function FixedThemeProvider({
  mode,
  children,
}: PropsWithChildren<{ mode: "light" | "dark" }>) {
  const outer = useContext(ThemeContext);
  const value = useMemo<ThemeProviderValue>(
    () => ({
      theme: themeForMode(mode),
      mode: outer?.mode ?? "system",
      setMode: outer?.setMode ?? (() => undefined),
    }),
    [mode, outer],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function ThemeProvider({ children }: PropsWithChildren) {
  const osScheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>("system");

  useEffect(() => {
    let active = true;

    AsyncStorage.getItem(THEME_STORAGE_KEY).then(
      (storedMode) => {
        if (active && isThemeMode(storedMode)) {
          setModeState(storedMode);
        }
      },
      () => undefined,
    );

    return () => {
      active = false;
    };
  }, []);

  const setMode = useCallback((nextMode: ThemeMode) => {
    setModeState(nextMode);
    AsyncStorage.setItem(THEME_STORAGE_KEY, nextMode).catch(() => undefined);
  }, []);

  const resolvedMode = resolveTheme(mode, osScheme);
  const value = useMemo<ThemeProviderValue>(
    () => ({ theme: themeForMode(resolvedMode), mode, setMode }),
    [mode, resolvedMode, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

function useThemeContext(): ThemeProviderValue {
  const value = useContext(ThemeContext);
  if (value === null) {
    throw new Error("Theme hooks must be used inside ThemeProvider");
  }
  return value;
}

export function useTheme(): Theme {
  return useThemeContext().theme;
}

export function useThemeMode(): { mode: ThemeMode; setMode: (mode: ThemeMode) => void } {
  const { mode, setMode } = useThemeContext();
  return { mode, setMode };
}
