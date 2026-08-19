/**
 * Where to send someone after they sign in.
 *
 * The value arrives from the URL, so it is attacker-controlled: an unchecked
 * `?next=` is an open redirect, and "sign in to continue" is exactly the
 * moment a person is primed to trust wherever they land. Only same-origin
 * *paths* survive — never an absolute URL, never a protocol-relative `//host`
 * (which a browser reads as another origin), never a scheme.
 */

const NEXT_PARAM = "next";

/** Where to land when there is no usable destination. */
export const DEFAULT_RETURN_PATH = "/";

/** Longer than any real route; a bounded value keeps this out of URL limits. */
const MAX_RETURN_PATH_LENGTH = 2048;

export function safeReturnPath(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim();
  if (!path || path.length > MAX_RETURN_PATH_LENGTH) return null;
  // Must be an origin-relative path...
  if (!path.startsWith("/")) return null;
  // ...and not a protocol-relative or backslash-smuggled authority. Browsers
  // normalize `\` to `/` in the authority position, so `/\evil.com` is a
  // cross-origin redirect on some of them.
  if (path.startsWith("//") || path.startsWith("/\\")) return null;
  // A control character can truncate or split the URL downstream.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  if (/[\u0000-\u001f\u007f]/u.test(path)) return null;
  return path;
}

/** The `?next=` on a URL, if it is safe to honor. */
export function returnPathFromParams(params: { get(name: string): string | null }): string | null {
  return safeReturnPath(params.get(NEXT_PARAM));
}

/** `/login?next=<here>`, so signing in comes back rather than dumping you home. */
export function loginPathFor(destination: string): string {
  const next = safeReturnPath(destination);
  if (next === null || next === DEFAULT_RETURN_PATH) return "/login";
  return `/login?${new URLSearchParams({ [NEXT_PARAM]: next })}`;
}
