/**
 * Experiment flag: unified scrollback.
 *
 * Unified mode writes committed history into the LIVE terminal's own
 * scrollback at seed time and lets xterm scroll natively through it — one
 * buffer, one coordinate space, like a desktop terminal. The overlay pipeline
 * keeps running dormant underneath (deltas still maintain the hidden pure
 * view), so the two implementations can be compared on the same session and
 * the toggle is trivially reversible.
 *
 * Read once per Terminal mount; the settings toggle reloads the app, which is
 * the honest lifecycle — terminals are kept warm across navigation, so a
 * mid-session flip would leave pool instances straddling both behaviours.
 */

const STORAGE_KEY = "spawnScrollback";

export function unifiedScrollbackEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "unified";
  } catch {
    return false;
  }
}

export function setUnifiedScrollbackEnabled(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(STORAGE_KEY, "unified");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage refused; the current mode simply persists.
  }
}
