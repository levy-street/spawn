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

/** Scrollback depths. The live terminal keeps a deep local buffer for replay;
 * the history overlay renders endpoint worker snapshots capped at this depth. */
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

/** Theme for the scrollback/history overlay terminal: identical, but the
 * cursor is painted in the background color so it is invisible. */
export const TERMINAL_SCROLLBACK_THEME = Object.freeze({
  background: "#0a0a0a",
  foreground: "#e5e5e5",
  cursor: "#0a0a0a",
});

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
