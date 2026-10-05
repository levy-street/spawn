/**
 * This page's id among the SPAWN D tabs of this browser: the same for every
 * host connection the page shares, so "which tab holds the connection to
 * dream" and "which tab runs this transfer" are the same question.
 *
 * Made once per page load, kept in memory only.
 */
let id: string | null = null;

export function browserTabId(): string {
  id ??= crypto.randomUUID();
  return id;
}
