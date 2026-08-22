import {
  clampDisplay,
  darkColors,
  darkTheme,
  grimoireColors,
  isThemeMode,
  lightColors,
  lightTheme,
  pressroomColors,
  resolveTheme,
  space,
  tabSurfaces,
  terminalDark,
  terminalLight,
  terminalLightSelectionSources,
  terminalPalette,
  themeForMode,
} from "@/theme";

function isValidNativeColor(value: string): boolean {
  if (/^#[0-9a-f]{6}$/i.test(value)) {
    return true;
  }

  const rgba = /^rgba\((\d{1,3}),(\d{1,3}),(\d{1,3}),(0|1|0?\.\d+)\)$/.exec(value);
  if (rgba === null) {
    return false;
  }

  const channels = rgba.slice(1, 4).map(Number);
  const alpha = Number(rgba[4]);
  return channels.every((channel) => channel >= 0 && channel <= 255) && alpha >= 0 && alpha <= 1;
}

function expectValidColors(palette: Record<string, string>): void {
  for (const [name, value] of Object.entries(palette)) {
    expect({ name, value }).toEqual({ name, value: expect.any(String) });
    expect(isValidNativeColor(value)).toBe(true);
  }
}

describe("semantic colors", () => {
  it("keeps light and dark semantic keys in parity", () => {
    expect(Object.keys(darkColors).sort()).toEqual(Object.keys(lightColors).sort());
  });

  it("uses React Native-compatible literals for every color token", () => {
    const palettes = [
      lightColors,
      darkColors,
      pressroomColors,
      grimoireColors,
      tabSurfaces.light,
      tabSurfaces.dark,
      terminalLight,
      terminalDark,
      terminalLightSelectionSources,
    ];

    for (const palette of palettes) {
      expectValidColors(palette);
    }
  });

  it("keeps light and dark terminal keys in parity", () => {
    expect(Object.keys(terminalDark).sort()).toEqual(Object.keys(terminalLight).sort());
  });
});

describe("spacing", () => {
  it.each([
    [0, 0],
    [0.5, 2],
    [1, 4],
    [3.5, 14],
    [-1, -4],
  ])("maps %s units to %s pixels", (units, pixels) => {
    expect(space(units)).toBe(pixels);
  });
});

describe("token helpers", () => {
  it("clamps display sizes to the declared viewport range", () => {
    expect(clampDisplay(320, 24, 3.7, 35)).toBe(24);
    expect(clampDisplay(800, 24, 3.7, 35)).toBe(29.6);
    expect(clampDisplay(1200, 24, 3.7, 35)).toBe(35);
  });

  it("selects terminal and assembled palettes by resolved mode", () => {
    expect(terminalPalette("light")).toBe(terminalLight);
    expect(terminalPalette("dark")).toBe(terminalDark);
    expect(themeForMode("light")).toBe(lightTheme);
    expect(themeForMode("dark")).toBe(darkTheme);
  });
});

describe("theme mode", () => {
  it("resolves explicit modes independently of the OS", () => {
    expect(resolveTheme("light", "dark")).toBe("light");
    expect(resolveTheme("dark", "light")).toBe("dark");
  });

  it("resolves system mode from the OS scheme", () => {
    expect(resolveTheme("system", "light")).toBe("light");
    expect(resolveTheme("system", "dark")).toBe("dark");
    expect(resolveTheme("system", null)).toBe("dark");
    expect(resolveTheme("system", undefined)).toBe("dark");
  });

  it("validates persisted values", () => {
    expect(isThemeMode("light")).toBe(true);
    expect(isThemeMode("dark")).toBe(true);
    expect(isThemeMode("system")).toBe(true);
    expect(isThemeMode("sepia")).toBe(false);
    expect(isThemeMode(null)).toBe(false);
  });
});

describe("assembled themes", () => {
  it("matches the light token snapshot", () => {
    expect(lightTheme).toMatchSnapshot();
  });

  it("matches the dark token snapshot", () => {
    expect(darkTheme).toMatchSnapshot();
  });
});
