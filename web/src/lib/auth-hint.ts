/*
 * A client-side hint that this browser has held a session before. The
 * session cookie is HTTP-only, so the page cannot see it; without a hint
 * the only way to learn "signed in?" is to ask /api/me, and for a stranger
 * that answer is a 401 the browser logs as an error on every public page.
 * The hint lets surfaces that merely *prefer* to know (the public masthead)
 * skip the question when it has never once been answered yes.
 */

export const SIGNED_IN_HINT_KEY = "spawn.signed-in.v1";

export function readSignedInHint(storage: Pick<Storage, "getItem"> | null = defaultStorage()) {
  try {
    return storage?.getItem(SIGNED_IN_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSignedInHint(
  signedIn: boolean,
  storage: Pick<Storage, "setItem" | "removeItem"> | null = defaultStorage(),
) {
  try {
    if (signedIn) storage?.setItem(SIGNED_IN_HINT_KEY, "1");
    else storage?.removeItem(SIGNED_IN_HINT_KEY);
  } catch {
    // Storage blocked or full: the hint is a courtesy, nothing owed.
  }
}

function defaultStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
