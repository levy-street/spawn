export const terminalMetrics = {
  fontSize: 13,
  lineHeightMultiplier: 1.2,
  lineHeight: 15.6,
  scrollbackLines: 100_000,
  snapshotLines: 10_000,
  unicodeVersion: "11",
  cursorBlink: true,
  scrollOnUserInput: true,
  smoothScrollDuration: 0,
  convertEol: false,
} as const;

export const terminalDark = {
  background: "#0A0A0A",
  foreground: "#E5E5E5",
  cursor: "#E5E5E5",
  cursorAccent: "#000000",
  selectionBackground: "rgba(255,255,255,0.30)",
  selectionInactiveBackground: "rgba(255,255,255,0.30)",
  black: "#2E3436",
  red: "#CC0000",
  green: "#4E9A06",
  yellow: "#C4A000",
  blue: "#3465A4",
  magenta: "#75507B",
  cyan: "#06989A",
  white: "#D3D7CF",
  brightBlack: "#555753",
  brightRed: "#EF2929",
  brightGreen: "#8AE234",
  brightYellow: "#FCE94F",
  brightBlue: "#729FCF",
  brightMagenta: "#AD7FA8",
  brightCyan: "#34E2E2",
  brightWhite: "#EEEEEC",
} as const;

export type TerminalPalette = { readonly [Key in keyof typeof terminalDark]: string };
export type TerminalTheme = TerminalPalette;

export const terminalLight = {
  background: "#FCFCFC",
  foreground: "#1F1F1F",
  cursor: "#1F1F1F",
  cursorAccent: "#FCFCFC",
  selectionBackground: "rgba(172,206,247,0.30)",
  selectionInactiveBackground: "rgba(225,230,235,0.30)",
  black: "#000000",
  red: "#CD3131",
  green: "#00BC00",
  yellow: "#949800",
  blue: "#0451A5",
  magenta: "#BC05BC",
  cyan: "#0598BC",
  white: "#555555",
  brightBlack: "#666666",
  brightRed: "#CD3131",
  brightGreen: "#14CE14",
  brightYellow: "#B5BA00",
  brightBlue: "#0451A5",
  brightMagenta: "#BC05BC",
  brightCyan: "#0598BC",
  brightWhite: "#A5A5A5",
} as const satisfies TerminalPalette;

export const terminalLightSelectionSources = {
  selectionBackground: "#ACCEF7",
  selectionInactiveBackground: "#E1E6EB",
} as const;

export function terminalPalette(theme: "light" | "dark"): TerminalPalette {
  return theme === "light" ? terminalLight : terminalDark;
}
