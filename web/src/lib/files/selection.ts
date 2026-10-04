/**
 * The file browser's selection: a set of selected keys, an anchor that Shift
 * extends from, and a focused row that the keyboard moves — separate from
 * the selection, so ⌘/Ctrl can move or toggle without losing what is already
 * picked (Windows' Ctrl+Arrow, then Ctrl+Space).
 *
 * Every operation that depends on order takes the visible order, so a range
 * is always the rows a person can see between the two ends — never rows the
 * filter has hidden or a collapsed folder holds.
 *
 * Keys are entry paths. Pure and DOM-free.
 */

export interface SelectionState {
  readonly selected: ReadonlySet<string>;
  readonly anchor: string | null;
  readonly focus: string | null;
}

export const EMPTY_SELECTION: SelectionState = {
  selected: new Set(),
  anchor: null,
  focus: null,
};

export type FocusTarget = "prev" | "next" | "first" | "last" | { by: number };

/**
 * What a focus move does to the selection: replace it with the focused row,
 * extend the range from the anchor to it, or leave it alone.
 */
export type MoveMode = "select" | "extend" | "focus";

export function selectOnly(key: string): SelectionState {
  return { selected: new Set([key]), anchor: key, focus: key };
}

/** Several rows picked at once (what a delete could not remove); the first leads. */
export function selectKeys(keys: readonly string[]): SelectionState {
  const first = keys[0] ?? null;
  return { selected: new Set(keys), anchor: first, focus: first };
}

export function isSelected(state: SelectionState, key: string): boolean {
  return state.selected.has(key);
}

/** ⌘/Ctrl-click: add or remove one row; it becomes the new anchor. */
export function toggleKey(state: SelectionState, key: string): SelectionState {
  const selected = new Set(state.selected);
  if (selected.has(key)) selected.delete(key);
  else selected.add(key);
  return { selected, anchor: key, focus: key };
}

/** Ctrl+Space: toggle whatever row has the focus. */
export function toggleFocused(state: SelectionState): SelectionState {
  return state.focus === null ? state : toggleKey(state, state.focus);
}

function rangeBetween(order: readonly string[], from: string, to: string): string[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a < 0 || b < 0) return b >= 0 ? [to] : [];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/**
 * Shift-click or Shift+Arrow: everything from the anchor to `key`. With
 * `additive` (⌘/Ctrl held too) the range joins what is already selected;
 * without it the range is the whole selection. The anchor stays put, so a
 * second Shift-click re-draws the range from the same place.
 */
export function selectRange(
  order: readonly string[],
  state: SelectionState,
  key: string,
  { additive = false }: { additive?: boolean } = {},
): SelectionState {
  const anchor = state.anchor !== null && order.includes(state.anchor) ? state.anchor : key;
  const range = rangeBetween(order, anchor, key);
  const selected = new Set(additive ? state.selected : []);
  for (const item of range) selected.add(item);
  return { selected, anchor, focus: key };
}

export function selectAll(order: readonly string[], state: SelectionState): SelectionState {
  if (order.length === 0) return state;
  const focus = state.focus !== null && order.includes(state.focus) ? state.focus : order[0];
  return { selected: new Set(order), anchor: order[0] ?? null, focus: focus ?? null };
}

/** Where `target` lands, from the focused row (or the edge when none is). */
export function focusIndex(
  order: readonly string[],
  state: SelectionState,
  target: FocusTarget,
): number {
  if (order.length === 0) return -1;
  const current = state.focus === null ? -1 : order.indexOf(state.focus);
  const last = order.length - 1;
  if (target === "first") return 0;
  if (target === "last") return last;
  if (current < 0) return target === "prev" ? last : 0;
  const delta = target === "prev" ? -1 : target === "next" ? 1 : target.by;
  return Math.max(0, Math.min(last, current + delta));
}

export function moveFocus(
  order: readonly string[],
  state: SelectionState,
  target: FocusTarget,
  mode: MoveMode,
): SelectionState {
  const index = focusIndex(order, state, target);
  const key = index < 0 ? null : (order[index] ?? null);
  if (key === null) return state;
  if (mode === "extend") return selectRange(order, state, key);
  if (mode === "focus") return { ...state, focus: key };
  return selectOnly(key);
}

/**
 * After the list changes (a refresh, a filter, a delete): drop keys that are
 * gone. The focus and anchor survive only if their rows still exist.
 * Returns the same object when nothing changed, so a poll that moved nothing
 * re-renders nothing.
 */
export function reconcileSelection(
  order: readonly string[],
  state: SelectionState,
): SelectionState {
  const present = new Set(order);
  let changed = false;
  const selected = new Set<string>();
  for (const key of state.selected) {
    if (present.has(key)) selected.add(key);
    else changed = true;
  }
  const anchor = state.anchor !== null && present.has(state.anchor) ? state.anchor : null;
  const focus = state.focus !== null && present.has(state.focus) ? state.focus : null;
  if (!changed && anchor === state.anchor && focus === state.focus) return state;
  return { selected, anchor, focus };
}

/** The selected keys in the order they are shown. */
export function selectedInOrder(order: readonly string[], state: SelectionState): string[] {
  return order.filter((key) => state.selected.has(key));
}

/** A rename moved one row to a new key; everything that pointed at it follows. */
export function renameKey(state: SelectionState, from: string, to: string): SelectionState {
  const swap = (key: string | null) => (key === from ? to : key);
  if (!state.selected.has(from) && state.anchor !== from && state.focus !== from) return state;
  const selected = new Set([...state.selected].map((key) => (key === from ? to : key)));
  return { selected, anchor: swap(state.anchor), focus: swap(state.focus) };
}
