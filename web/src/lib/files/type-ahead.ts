/**
 * Type-ahead: typing letters jumps to the row whose name starts with them,
 * as in every desktop file manager. Letters typed within a second build one
 * prefix; a pause starts a new one. Typing the same letter again steps to
 * the next name starting with it, so "s s s" walks through src, scripts and
 * server the way Explorer and the WAI-ARIA tree pattern do.
 *
 * Pure: the clock is passed in.
 */

export const TYPE_AHEAD_RESET_MS = 1_000;

export interface TypeAheadState {
  readonly buffer: string;
  readonly at: number;
}

export function pushTypeAhead(
  state: TypeAheadState | null,
  char: string,
  now: number,
): TypeAheadState {
  const fresh = state === null || now - state.at > TYPE_AHEAD_RESET_MS;
  return { buffer: fresh ? char : state.buffer + char, at: now };
}

function startsWith(name: string, prefix: string): boolean {
  return name.toLowerCase().startsWith(prefix.toLowerCase());
}

function search(names: readonly string[], prefix: string, start: number): number {
  const count = names.length;
  for (let step = 0; step < count; step += 1) {
    const index = (((start + step) % count) + count) % count;
    const name = names[index];
    if (name !== undefined && startsWith(name, prefix)) return index;
  }
  return -1;
}

/**
 * The row `buffer` lands on, searching from the focused row `from`, or -1.
 * One letter looks past the current row, so it steps on; a longer prefix
 * includes it, so typing on refines the row already found.
 */
export function typeAheadMatch(names: readonly string[], buffer: string, from: number): number {
  if (!buffer || names.length === 0) return -1;
  const origin = from < 0 ? 0 : from;
  if ([...buffer].length === 1) return search(names, buffer, from < 0 ? 0 : origin + 1);
  const found = search(names, buffer, origin);
  if (found >= 0) return found;
  // "sss" with no name starting "sss" is someone stepping through the s's.
  const first = [...buffer][0] ?? "";
  if ([...buffer].every((char) => char.toLowerCase() === first.toLowerCase())) {
    return search(names, first, origin + 1);
  }
  return -1;
}
