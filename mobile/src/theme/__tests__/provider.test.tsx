import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";

import {
  darkTheme,
  lightTheme,
  THEME_STORAGE_KEY,
  ThemeProvider,
  useTheme,
  useThemeMode,
} from "@/theme";

function wrapper({ children }: PropsWithChildren) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

function useThemeState() {
  return { theme: useTheme(), themeMode: useThemeMode() };
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
  });

  it("defaults to system mode", async () => {
    const { result } = await renderHook(useThemeMode, { wrapper });
    expect(result.current.mode).toBe("system");
  });

  it("restores a valid persisted mode", async () => {
    jest.mocked(AsyncStorage.getItem).mockResolvedValueOnce("light");

    const { result } = await renderHook(useThemeMode, { wrapper });

    await waitFor(() => {
      expect(result.current.mode).toBe("light");
    });
    expect(AsyncStorage.getItem).toHaveBeenCalledWith(THEME_STORAGE_KEY);
  });

  it("ignores an invalid persisted mode", async () => {
    jest.mocked(AsyncStorage.getItem).mockResolvedValueOnce("sepia");

    const { result } = await renderHook(useThemeMode, { wrapper });

    await waitFor(() => {
      expect(AsyncStorage.getItem).toHaveBeenCalledWith(THEME_STORAGE_KEY);
    });
    expect(result.current.mode).toBe("system");
  });

  it("switches assembled themes and persists explicit choices", async () => {
    const { result } = await renderHook(useThemeState, { wrapper });

    await act(() => {
      result.current.themeMode.setMode("dark");
    });

    expect(result.current.theme).toBe(darkTheme);
    await waitFor(() => {
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "dark");
    });

    await act(() => {
      result.current.themeMode.setMode("light");
    });

    expect(result.current.theme).toBe(lightTheme);
    await waitFor(() => {
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "light");
    });
  });
});
