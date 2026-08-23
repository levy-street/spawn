const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

/** Quotes a path the way a shell needs it, and only when it needs it. */
export function shellQuotePath(path: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(path)) return path;
  return `'${path.replaceAll("'", "'\\''")}'`;
}

/**
 * Wraps text as a bracketed paste, which is how a terminal distinguishes
 * pasted content from typing. It is what a desktop terminal sends when a file
 * is dragged onto it, and what an agent reads as "here is a file", so an
 * attached image arrives at the prompt the same way on a phone.
 */
export function bracketedPaste(text: string): string {
  return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}

/**
 * The full sequence for handing an uploaded attachment to the prompt.
 *
 * The path stays absolute. An agent decides whether a pasted token is a file
 * by resolving it, and a bare relative path is indistinguishable from prose —
 * shortened, it lands as literal text instead of becoming an image.
 */
export function attachmentPasteSequence(path: string): string {
  return bracketedPaste(shellQuotePath(path));
}
