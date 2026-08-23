/**
 * Single source of truth for the xterm.js terminal configuration spawn ships.
 *
 * Imported by BOTH:
 *   - the browser client (web/src/components/terminal/Terminal.tsx), and
 *   - the conformance SUT runner (tools/term-conformance/sut-xterm/run.mjs).
 *
 * The conformance pipeline (tools/term-conformance/) replays raw escape-byte
 * corpora through @xterm/headless — the same emulation core as @xterm/xterm —
 * using EXACTLY these options, so grid-level test results describe the
 * terminal users actually get. If you change an emulation-affecting option
 * here, re-run `uv run driver.py full-run` in tools/term-conformance/.
 *
 * Plain .mjs (not .ts) so Node can import it without a transpile step.
 */

/** Rendering metrics (browser-only; no effect on grid emulation). */
export const TERMINAL_FONT_SIZE = 13;
export const TERMINAL_LINE_HEIGHT = 1.2;
export const TERMINAL_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

/** Scrollback depths. The live terminal's buffer holds committed history
 * plus live output; snapshot fetches are capped at the daemon's line limit. */
export const TERMINAL_SCROLLBACK_LINES = 100_000;
export const TERMINAL_SNAPSHOT_LINES = 10_000;

/** Theme for the live terminal. Only default fg/bg/cursor are overridden; the
 * 16-color ANSI palette stays at xterm.js defaults, matching the conformance
 * assumption that palette indices 0-15 are theme-resolved (grid states store
 * indices, never theme RGB). */
export const TERMINAL_THEME = Object.freeze({
  background: "#0a0a0a",
  foreground: "#e5e5e5",
  cursor: "#e5e5e5",
});

/**
 * Light terminal.
 *
 * Unlike the dark theme this cannot leave the ANSI palette alone. xterm.js's
 * defaults are chosen for a dark background — index 7 ("white") is near-white
 * and index 11 ("bright yellow") is a pale straw, both invisible on a light
 * one, and TUIs use those constantly. The 16 below are VS Code's Light+
 * terminal palette, which exists precisely to be legible on white.
 *
 * Conformance is unaffected: grid states store palette indices, never RGB.
 */
const LIGHT_ANSI = Object.freeze({
  black: "#000000",
  red: "#cd3131",
  green: "#00bc00",
  yellow: "#949800",
  blue: "#0451a5",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#b5ba00",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#a5a5a5",
});

/**
 * Solarized's 16, shared by both polarities exactly as Ethan Schoonover
 * specified — the point of the palette is that the same colours stay legible
 * against either end of its base scale.
 */
const SOLARIZED_ANSI = Object.freeze({
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#002b36",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
});

const LIGHT_BACKGROUND = "#fcfcfc";
const LIGHT_FOREGROUND = "#1f1f1f";

export const TERMINAL_THEME_LIGHT = Object.freeze({
  ...LIGHT_ANSI,
  background: LIGHT_BACKGROUND,
  foreground: LIGHT_FOREGROUND,
  cursor: LIGHT_FOREGROUND,
  cursorAccent: LIGHT_BACKGROUND,
  // xterm's default selection is a pale wash that vanishes on a light
  // background, taking "what have I highlighted" with it.
  selectionBackground: "#accef7",
  selectionInactiveBackground: "#e1e6eb",
});

/**
 * The curated set. Half a dozen good ones, not fifty.
 *
 * Each declares its `polarity` so the picker can group them and so nothing
 * silently puts a light palette on a dark background. Every theme added here
 * ships a full 16-colour ANSI palette, for the reason the light theme
 * documents above: xterm.js's defaults are tuned for a dark background, and a
 * palette that only sets bg/fg inherits colours that may be invisible.
 *
 * `spawn-dark` is the exception, deliberately: it is what ships today, and
 * writing out an explicit palette for it would risk changing the default
 * terminal's appearance for everyone over a transcription slip. It inherits
 * xterm's dark-tuned defaults exactly as it does now.
 *
 * Conformance is unaffected by anything in here — grid states store palette
 * indices, never theme RGB, and the SUT does not import this.
 */
export const TERMINAL_THEMES = Object.freeze([
  Object.freeze({
    id: "spawn-dark",
    label: "spawn dark",
    polarity: "dark",
    theme: TERMINAL_THEME,
  }),
  Object.freeze({
    id: "spawn-light",
    label: "spawn light",
    polarity: "light",
    theme: TERMINAL_THEME_LIGHT,
  }),
  Object.freeze({
    id: "solarized-dark",
    label: "Solarized dark",
    polarity: "dark",
    theme: Object.freeze({
      ...SOLARIZED_ANSI,
      background: "#002b36",
      foreground: "#839496",
      cursor: "#93a1a1",
      cursorAccent: "#002b36",
      selectionBackground: "#073642",
      selectionInactiveBackground: "#073642",
    }),
  }),
  Object.freeze({
    id: "solarized-light",
    label: "Solarized light",
    polarity: "light",
    theme: Object.freeze({
      // Solarized deliberately keeps one 16-colour set for both polarities;
      // only the background and foreground swap ends of the base scale.
      ...SOLARIZED_ANSI,
      background: "#fdf6e3",
      foreground: "#657b83",
      cursor: "#586e75",
      cursorAccent: "#fdf6e3",
      selectionBackground: "#eee8d5",
      selectionInactiveBackground: "#eee8d5",
    }),
  }),
  Object.freeze({
    id: "gruvbox-dark",
    label: "Gruvbox dark",
    polarity: "dark",
    theme: Object.freeze({
      black: "#282828",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#a89984",
      brightBlack: "#928374",
      brightRed: "#fb4934",
      brightGreen: "#b8bb26",
      brightYellow: "#fabd2f",
      brightBlue: "#83a598",
      brightMagenta: "#d3869b",
      brightCyan: "#8ec07c",
      brightWhite: "#ebdbb2",
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#ebdbb2",
      cursorAccent: "#282828",
      selectionBackground: "#504945",
      selectionInactiveBackground: "#3c3836",
    }),
  }),
  Object.freeze({
    id: "nord",
    label: "Nord",
    polarity: "dark",
    theme: Object.freeze({
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      cursorAccent: "#2e3440",
      selectionBackground: "#434c5e",
      selectionInactiveBackground: "#3b4252",
    }),
  }),
]);

/** Follow the app's light/dark rather than pinning a palette. The default. */
export const TERMINAL_THEME_AUTO = "auto";

export function terminalThemeById(id) {
  return TERMINAL_THEMES.find((entry) => entry.id === id) ?? null;
}

/**
 * @param {"light"|"dark"} resolved  the app theme, for the "auto" case
 * @param {string} [themeId]         an explicit pick, or "auto"/undefined
 */
export function terminalTheme(resolved, themeId) {
  const chosen = themeId && themeId !== TERMINAL_THEME_AUTO ? terminalThemeById(themeId) : null;
  if (chosen) return chosen.theme;
  return resolved === "light" ? TERMINAL_THEME_LIGHT : TERMINAL_THEME;
}

/**
 * Font choices offered in Settings.
 *
 * `system` is the stack that ships today and always works. The rest are
 * patched Nerd Fonts, offered only when the *viewer's device* actually has
 * them: nothing here is downloaded, so an agent TUI's powerline and devicon
 * glyphs render for the people who already live in terminals, and everyone
 * else is not shown a choice that would silently fall back to a face without
 * those glyphs.
 *
 * Self-hosting a subsetted face is the other half of this and is deliberately
 * not done here — a patched face is multiple MB against the PWA precache, and
 * each one needs its licence vetted and its notice carried.
 */
export const TERMINAL_FONT_OPTIONS = Object.freeze([
  // `probe: null` rather than omitted, so every entry has the same shape and
  // consumers do not have to narrow a union to ask the question.
  Object.freeze({
    id: "system",
    label: "System monospace",
    probe: null,
    stack: TERMINAL_FONT_FAMILY,
  }),
  Object.freeze({
    id: "jetbrains-mono-nf",
    label: "JetBrainsMono Nerd Font",
    probe: "JetBrainsMono Nerd Font",
    stack: `"JetBrainsMono Nerd Font", "JetBrainsMono NF", ${TERMINAL_FONT_FAMILY}`,
  }),
  Object.freeze({
    id: "meslo-nf",
    label: "MesloLGS Nerd Font",
    probe: "MesloLGS NF",
    stack: `"MesloLGS NF", "MesloLGS Nerd Font", ${TERMINAL_FONT_FAMILY}`,
  }),
  Object.freeze({
    id: "fira-code-nf",
    label: "FiraCode Nerd Font",
    probe: "FiraCode Nerd Font",
    stack: `"FiraCode Nerd Font", "FiraCode NF", ${TERMINAL_FONT_FAMILY}`,
  }),
  Object.freeze({
    id: "hack-nf",
    label: "Hack Nerd Font",
    probe: "Hack Nerd Font",
    stack: `"Hack Nerd Font", "Hack NF", ${TERMINAL_FONT_FAMILY}`,
  }),
  Object.freeze({
    id: "cascadia-code",
    label: "Cascadia Code",
    probe: "Cascadia Code",
    stack: `"Cascadia Code", "Cascadia Mono", ${TERMINAL_FONT_FAMILY}`,
  }),
]);

export function terminalFontOptionById(id) {
  return TERMINAL_FONT_OPTIONS.find((option) => option.id === id) ?? null;
}

export function terminalFontStack(id) {
  return terminalFontOptionById(id)?.stack ?? TERMINAL_FONT_FAMILY;
}

/** Bounds for the size/line-height controls, and for rejecting stored junk. */
export const TERMINAL_FONT_SIZE_RANGE = Object.freeze({ min: 9, max: 24 });
export const TERMINAL_LINE_HEIGHT_RANGE = Object.freeze({ min: 1.0, max: 2.0 });

/**
 * Unicode tables version used for character widths (wcwidth). "11" via
 * @xterm/addon-unicode11 gives emoji width 2, matching iTerm2/modern
 * terminals; xterm.js's built-in default is Unicode 6 where emoji are
 * width 1 and render overlapped.
 */
export const TERMINAL_UNICODE_VERSION = "11";

/**
 * Options that affect terminal EMULATION (grid state), shared verbatim
 * between the browser terminals and the conformance SUT.
 *
 * - allowProposedApi: required by Unicode11Addon and the buffer-inspection
 *   API the SUT serializes grids from.
 * - convertEol: raw PTY bytes arrive with real \r\n discipline; never
 *   synthesize carriage returns.
 */
export const XTERM_EMULATION_OPTIONS = Object.freeze({
  allowProposedApi: true,
  convertEol: false,
});

/**
 * Load + activate the Unicode 11 width tables on a terminal.
 * The addon class is passed in so this module stays dependency-free and each
 * consumer (browser bundle, headless SUT) resolves its own copy.
 *
 * @param {{ loadAddon(addon: unknown): void, unicode: { activeVersion: string } }} term
 * @param {new () => unknown} Unicode11Addon
 */
export function activateUnicodeVersion(term, Unicode11Addon) {
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = TERMINAL_UNICODE_VERSION;
}
