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

/** @param {"light"|"dark"} resolved */
export function terminalTheme(resolved) {
  return resolved === "light" ? TERMINAL_THEME_LIGHT : TERMINAL_THEME;
}

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
