import { detectOS, type PlatformOS } from "@/lib/platform";

/**
 * Who owns a chord: the shell inside the terminal, or the app around it.
 *
 * A terminal is a keyboard application running inside a keyboard application,
 * and on a Mac the two used to disagree about ⌥. Down there, ⌥←/⌥→ is how a
 * shell moves the cursor a word at a time. Up here, the grid bound bare
 * Alt+Arrow to pane focus on the document in the *capture* phase, so it took
 * those presses before the terminal could ever see them: moving back a word
 * moved the focus to the next pane instead, which is the one thing a person
 * doing it does not want.
 *
 * Windows and Linux have no such collision. There the word chord is
 * Ctrl+Arrow, Alt+Arrow is what Windows Terminal itself uses to move between
 * panes, and there is no ⌘ to reach for — the Windows key is taken by the OS
 * and never reaches the page. So this is a per-platform rule, not a universal
 * one:
 *
 *   macOS      ⌥+Arrow → shell    ⌃⌥ and ⌘⌥ +Arrow → app    Ctrl+Arrow → shell
 *   elsewhere  Alt+Arrow → app                              Ctrl+Arrow → shell
 *
 * On a Mac the bare ⌥+Arrow still moves the focus everywhere no terminal
 * wants it — the canvas, a file explorer pane — so the muscle memory survives;
 * ⌥ goes back to the shell only where a shell is listening. The chord that
 * always works is ⌃⌥, because ⌘⌥+Arrow is Chrome's and Safari's own tab
 * switcher and a page cannot reliably take it back. ⌘⌥ is accepted too: it is
 * what iTerm2 uses for the same job, and inside the desktop app — a window
 * with no tabs — nothing else wants it.
 *
 * Alt+1…9 stays the app's on every platform, terminal or not. The shell has a
 * real, universal binding for ⌥+Arrow and effectively none for ⌥+digit, and
 * reaching another workspace from inside a terminal — which is where the
 * keyboard nearly always is — is worth more than the digit argument it would
 * hand readline.
 */

/** The subset of a KeyboardEvent a chord is decided from. */
export interface Chord {
  key: string;
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export type GridShortcut =
  | { kind: "workspace"; position: number }
  | { kind: "focus"; forward: boolean };

/** Keyboards with a ⌘ beside the space bar, where ⌥ is the shell's word key. */
export function usesAppleModifiers(os: PlatformOS): boolean {
  return os === "macos" || os === "ios";
}

/** The same question of the live browser. SSR-safe; assumes not-Apple. */
export function detectAppleModifiers(): boolean {
  if (typeof navigator === "undefined") return false;
  return usesAppleModifiers(
    detectOS(navigator.platform, navigator.userAgent, navigator.maxTouchPoints),
  );
}

/**
 * Is this keystroke one a terminal — or any other text surface — is waiting
 * for? Read from the event's target rather than from the focused pane: a
 * press only reaches xterm when its helper textarea holds the focus, and that
 * is exactly what the target says.
 */
export function keystrokeBelongsToText(target: EventTarget | null): boolean {
  // `Element` is absent under the unit-test runner and on the server; a
  // keystroke there is nobody's, which is the honest answer either way.
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  if (target.closest(".xterm")) return true;
  const element = target as HTMLElement;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  return tag === "INPUT" || tag === "TEXTAREA";
}

/**
 * What the workspace grid should do with a press, or null to leave it alone.
 *
 * `textHasKey` is [`keystrokeBelongsToText`] of the event's target. It only
 * withholds the bare ⌥+Arrow chords on an Apple keyboard — the only ones a
 * shell also wants.
 */
export function gridShortcut(
  event: Chord,
  options: { apple: boolean; textHasKey: boolean },
): GridShortcut | null {
  if (!event.altKey || event.shiftKey) return null;
  // ⌃⌥ and ⌘⌥ are the Mac's app chords; both at once is nobody's. Elsewhere
  // Alt is the app's and Ctrl is the shell's, so neither may be held.
  if (options.apple ? event.ctrlKey && event.metaKey : event.ctrlKey || event.metaKey) {
    return null;
  }
  const digit = /^Digit([1-9])$/u.exec(event.code)?.[1];
  if (digit) return { kind: "workspace", position: Number(digit) };
  const bare = options.apple && !event.ctrlKey && !event.metaKey;
  if (bare && options.textHasKey) return null;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    return { kind: "focus", forward: true };
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    return { kind: "focus", forward: false };
  }
  return null;
}

/**
 * The bytes a Mac's ⌥ or ⌘ arrow owes the shell, or null.
 *
 * Both halves of Mac text navigation are stated here rather than left to
 * xterm.js, because xterm decides the ⌥ half from its own `isMac` — and
 * `isMac` is wrong in this bundle. Its platform module reads
 * `typeof process !== "undefined"` to tell a browser from Node, and the
 * bundler hands every module a `process` shim, so xterm concludes it is
 * running in Node, `isMac` is false, and ⌥← comes out as `ESC [1;5D`: the
 * Windows spelling of the chord, which zsh does not bind at all. `ESC b` /
 * `ESC f` is the spelling readline, zsh, fish and the TUI prompts people run
 * here all understand.
 *
 * The ⌘ half xterm never had: `metaKey` breaks out of its arrow handling
 * before a sequence is chosen, so ⌘←/⌘→ did nothing whatsoever in a terminal
 * that is otherwise a faithful one. Every Mac terminal people arrive from
 * binds them to the ends of the line — iTerm2's "Natural Text Editing" preset
 * and Ghostty's defaults both send Ctrl-A and Ctrl-E.
 *
 * Only one modifier at a time, and never with ⇧ or ⌃: ⌃⌥ and ⌘⌥ belong to the
 * grid, and the grid takes them in the capture phase before this is asked.
 */
export function appleArrowBytes(event: Chord): string | null {
  if (event.ctrlKey || event.shiftKey || event.altKey === event.metaKey) return null;
  if (event.altKey) {
    if (event.key === "ArrowLeft") return "\x1bb";
    if (event.key === "ArrowRight") return "\x1bf";
    return null;
  }
  if (event.key === "ArrowLeft") return "\x01";
  if (event.key === "ArrowRight") return "\x05";
  return null;
}

/**
 * What a press means inside a file browser, or null to leave it alone.
 *
 * The map is Finder's on a Mac and Explorer's elsewhere, with two rules that
 * keep it from ever taking a key that is somebody else's:
 *
 * - No ⌥/Alt+anything. ⌥/Alt+Arrow is the grid's (see `gridShortcut`), Alt
 *   with a letter is a menu accelerator or, on Windows, AltGr typing a
 *   character — matching on `key` with Alt down would turn a German `[` into
 *   "Back". The one exception is ⌥⌘⌫, Finder's own "delete immediately".
 * - Nothing while a text field has the key (`textHasKey`): a rename box or
 *   the filter is typing, not navigating.
 *
 * Browser-reserved chords (⌘N, ⌘T, ⌘W, Ctrl+N, Ctrl+Shift+N…) are never
 * bound; New folder takes ⇧⌘N / Ctrl+Shift+N only inside the desktop app,
 * which has no tabs to open. Back and Forward are ⌘[ ⌘] / Ctrl+[ Ctrl+],
 * never Alt+Arrow.
 *
 * Return renames on a Mac, as in Finder and VS Code; Enter opens elsewhere,
 * as in Explorer. Delete permanently is the only delete there is until a host
 * can move things to its Trash, so every delete chord asks first.
 */
export type ExplorerShortcut =
  | {
      kind: "move";
      to: "prev" | "next" | "first" | "last" | "pageUp" | "pageDown";
      /** Shift: extend the selection from its anchor. */
      extend: boolean;
      /** Ctrl+Arrow (not on a Mac): move the focus and leave the selection. */
      keep: boolean;
    }
  | { kind: "expand" }
  | { kind: "collapse" }
  | { kind: "open" }
  | { kind: "rename" }
  | { kind: "up" }
  | { kind: "back" }
  | { kind: "forward" }
  | { kind: "selectAll" }
  | { kind: "toggleSelected" }
  | { kind: "peek" }
  | { kind: "delete" }
  | { kind: "toggleHidden" }
  | { kind: "filter" }
  | { kind: "goToFolder" }
  | { kind: "details" }
  | { kind: "newFolder" }
  | { kind: "escape" }
  | { kind: "typeAhead"; text: string };

export function explorerShortcut(
  event: Chord,
  options: { apple: boolean; textHasKey: boolean; desktopShell?: boolean },
): ExplorerShortcut | null {
  if (options.textHasKey) return null;
  const { key, shiftKey: shift } = event;
  const { apple } = options;
  if (event.altKey) {
    if (apple && event.metaKey && !event.ctrlKey && key === "Backspace") return { kind: "delete" };
    return null;
  }
  // The platform's command key, alone of the two: ⌘ on a Mac, Ctrl elsewhere.
  const command = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  const bare = !event.ctrlKey && !event.metaKey;
  const letter = key.length === 1 ? key.toLowerCase() : "";

  const move = (to: Extract<ExplorerShortcut, { kind: "move" }>["to"]): ExplorerShortcut => ({
    kind: "move",
    to,
    extend: shift,
    keep: false,
  });

  switch (key) {
    case "ArrowUp":
      if (bare) return move("prev");
      if (command && apple && !shift) return { kind: "up" };
      if (command && !apple) return { kind: "move", to: "prev", extend: shift, keep: !shift };
      return null;
    case "ArrowDown":
      if (bare) return move("next");
      if (command && apple && !shift) return { kind: "open" };
      if (command && !apple) return { kind: "move", to: "next", extend: shift, keep: !shift };
      return null;
    case "ArrowLeft":
      return bare && !shift ? { kind: "collapse" } : null;
    case "ArrowRight":
      return bare && !shift ? { kind: "expand" } : null;
    case "Home":
      return bare ? move("first") : null;
    case "End":
      return bare ? move("last") : null;
    case "PageUp":
      return bare ? move("pageUp") : null;
    case "PageDown":
      return bare ? move("pageDown") : null;
    case "Enter":
      if (!bare || shift) return null;
      return apple ? { kind: "rename" } : { kind: "open" };
    case "F2":
      return bare && !shift ? { kind: "rename" } : null;
    case "Escape":
      return bare ? { kind: "escape" } : null;
    case "Backspace":
      if (apple) return command && !shift ? { kind: "delete" } : null;
      return bare && !shift ? { kind: "up" } : null;
    case "Delete":
      return bare ? { kind: "delete" } : null;
    case " ":
      if (bare && !shift) return { kind: "peek" };
      if (!apple && command && !shift) return { kind: "toggleSelected" };
      return null;
  }

  if (command) {
    if (letter === "a" && !shift) return { kind: "selectAll" };
    if (letter === "o" && apple && !shift) return { kind: "open" };
    if (key === "[" && !shift) return { kind: "back" };
    if (key === "]" && !shift) return { kind: "forward" };
    if (letter === "f" && !shift) return { kind: "filter" };
    if (letter === "g" && shift) return { kind: "goToFolder" };
    if (letter === "i" && !shift) return { kind: "details" };
    // ⇧⌘. is Finder's; Shift turns "." into ">" on most layouts.
    if (apple && shift && (key === "." || key === ">")) return { kind: "toggleHidden" };
    if (!apple && letter === "h" && !shift) return { kind: "toggleHidden" };
    if (letter === "n" && shift && options.desktopShell) return { kind: "newFolder" };
    return null;
  }

  // Type-ahead: one printable character, Shift allowed for capitals.
  if (bare && [...key].length === 1 && key.trim() !== "") return { kind: "typeAhead", text: key };
  return null;
}
