import {
  isPathWithin,
  joinPath,
  normalizeAbsolutePath,
  normalizeCwdForHost,
  type PathFlavor,
  pathsEqual,
  trimTrailingSlash,
} from "@/lib/paths";

/**
 * Moving between folders: the Back/Forward history and "Go to folder".
 *
 * The browser itself never leaves home — the host's file service is rooted
 * there and answers anything above it with `outside_root` — so a typed path
 * is resolved and checked against home here first, and the host's own answer
 * is the second word on anything it can still refuse.
 *
 * Pure and DOM-free.
 */

/** Folders Back can reach. Enough for a long session, small enough to forget. */
export const HISTORY_LIMIT = 100;

export interface NavHistory {
  readonly stack: readonly string[];
  readonly index: number;
}

export function startHistory(path: string): NavHistory {
  return { stack: [path], index: 0 };
}

export function currentPath(history: NavHistory): string {
  return history.stack[history.index] ?? history.stack[0] ?? "";
}

/** Visiting a folder drops whatever Forward held, as a browser does. */
export function pushHistory(
  history: NavHistory,
  path: string,
  same: (a: string, b: string) => boolean = (a, b) => a === b,
): NavHistory {
  if (same(currentPath(history), path)) return history;
  const stack = [...history.stack.slice(0, history.index + 1), path].slice(-HISTORY_LIMIT);
  return { stack, index: stack.length - 1 };
}

export function canGoBack(history: NavHistory): boolean {
  return history.index > 0;
}

export function canGoForward(history: NavHistory): boolean {
  return history.index < history.stack.length - 1;
}

export function goBack(history: NavHistory): NavHistory {
  return canGoBack(history) ? { ...history, index: history.index - 1 } : history;
}

export function goForward(history: NavHistory): NavHistory {
  return canGoForward(history) ? { ...history, index: history.index + 1 } : history;
}

/** A path as a person reads it: `~` for home and `~/…` below it. */
export function displayPath(path: string, homeDir: string, flavor: PathFlavor): string {
  if (!homeDir) return path;
  const home = trimTrailingSlash(normalizeAbsolutePath(homeDir, flavor), flavor);
  if (pathsEqual(path, home, flavor)) return "~";
  if (!isPathWithin(path, home, flavor)) return path;
  const separator = flavor === "windows" ? "\\" : "/";
  const rest = trimTrailingSlash(normalizeAbsolutePath(path, flavor), flavor)
    .slice(home.length)
    .replace(/^[\\/]+/u, "");
  return `~${separator}${rest}`;
}

export type GoToFolder = { ok: true; path: string } | { ok: false; code: "empty" | "outside_root" };

/**
 * Resolve what someone typed into "Go to folder": `~`, `~/…`, an absolute
 * path, or a path relative to the folder they are in. `..` is resolved here;
 * the host refuses it on the wire.
 */
export function resolveGoToFolder(
  input: string,
  { homeDir, cwd, flavor }: { homeDir: string; cwd: string; flavor: PathFlavor },
): GoToFolder {
  const raw = input.trim();
  if (!raw) return { ok: false, code: "empty" };
  const home = trimTrailingSlash(normalizeAbsolutePath(homeDir, flavor), flavor);
  const tilde = raw === "~" || /^~[\\/]/u.test(raw);
  const absolute = flavor === "windows" ? /^(?:[A-Za-z]:|[\\/])/u.test(raw) : raw.startsWith("/");
  const path = tilde
    ? normalizeCwdForHost(raw, home, flavor)
    : absolute
      ? normalizeAbsolutePath(raw, flavor)
      : normalizeAbsolutePath(joinPath(cwd || home, raw, flavor), flavor);
  const resolved = trimTrailingSlash(path, flavor);
  if (!isPathWithin(resolved, home, flavor)) return { ok: false, code: "outside_root" };
  return { ok: true, path: resolved };
}
