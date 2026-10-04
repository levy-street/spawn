import { describe, expect, test } from "bun:test";
import {
  EMPTY_SELECTION,
  moveFocus,
  reconcileSelection,
  renameKey,
  type SelectionState,
  selectAll,
  selectedInOrder,
  selectKeys,
  selectOnly,
  selectRange,
  toggleFocused,
  toggleKey,
} from "./selection";

const order = ["a", "b", "c", "d", "e"];
const picked = (state: SelectionState) => selectedInOrder(order, state);

describe("clicking", () => {
  test("a plain click selects one row and anchors there", () => {
    const state = selectOnly("c");
    expect(picked(state)).toEqual(["c"]);
    expect(state.anchor).toBe("c");
    expect(state.focus).toBe("c");
  });

  test("⌘/Ctrl-click toggles one row and moves the anchor", () => {
    let state = selectOnly("a");
    state = toggleKey(state, "c");
    expect(picked(state)).toEqual(["a", "c"]);
    expect(state.anchor).toBe("c");
    state = toggleKey(state, "a");
    expect(picked(state)).toEqual(["c"]);
  });

  test("Shift-click selects from the anchor, and re-draws from the same anchor", () => {
    let state = selectOnly("b");
    state = selectRange(order, state, "d");
    expect(picked(state)).toEqual(["b", "c", "d"]);
    state = selectRange(order, state, "a");
    expect(picked(state)).toEqual(["a", "b"]);
    expect(state.anchor).toBe("b");
    expect(state.focus).toBe("a");
  });

  test("⌘/Ctrl+Shift-click adds a range to what is already picked", () => {
    let state = selectOnly("a");
    state = toggleKey(state, "d");
    state = selectRange(order, state, "e", { additive: true });
    expect(picked(state)).toEqual(["a", "d", "e"]);
  });

  test("Shift-click with nothing anchored selects just that row", () => {
    expect(picked(selectRange(order, EMPTY_SELECTION, "c"))).toEqual(["c"]);
  });
});

describe("the keyboard", () => {
  test("arrows move the selection, clamped at the ends", () => {
    let state = selectOnly("a");
    state = moveFocus(order, state, "next", "select");
    expect(picked(state)).toEqual(["b"]);
    state = moveFocus(order, state, "prev", "select");
    state = moveFocus(order, state, "prev", "select");
    expect(picked(state)).toEqual(["a"]);
  });

  test("with nothing focused, down starts at the top and up at the bottom", () => {
    expect(picked(moveFocus(order, EMPTY_SELECTION, "next", "select"))).toEqual(["a"]);
    expect(picked(moveFocus(order, EMPTY_SELECTION, "prev", "select"))).toEqual(["e"]);
  });

  test("Shift+Arrow extends from the anchor", () => {
    let state = selectOnly("b");
    state = moveFocus(order, state, "next", "extend");
    state = moveFocus(order, state, "next", "extend");
    expect(picked(state)).toEqual(["b", "c", "d"]);
    state = moveFocus(order, state, "first", "extend");
    expect(picked(state)).toEqual(["a", "b"]);
  });

  test("Ctrl+Arrow moves only the focus, and Ctrl+Space toggles there", () => {
    let state = selectOnly("a");
    state = moveFocus(order, state, "next", "focus");
    state = moveFocus(order, state, "next", "focus");
    expect(picked(state)).toEqual(["a"]);
    expect(state.focus).toBe("c");
    state = toggleFocused(state);
    expect(picked(state)).toEqual(["a", "c"]);
  });

  test("Home, End and page jumps", () => {
    expect(moveFocus(order, selectOnly("c"), "last", "select").focus).toBe("e");
    expect(moveFocus(order, selectOnly("c"), "first", "select").focus).toBe("a");
    expect(moveFocus(order, selectOnly("a"), { by: 3 }, "select").focus).toBe("d");
    expect(moveFocus(order, selectOnly("b"), { by: -10 }, "select").focus).toBe("a");
  });

  test("an empty list moves nowhere", () => {
    expect(moveFocus([], EMPTY_SELECTION, "next", "select")).toBe(EMPTY_SELECTION);
  });

  test("select all keeps the focus where it was", () => {
    const state = selectAll(order, selectOnly("c"));
    expect(picked(state)).toEqual(order);
    expect(state.focus).toBe("c");
  });
});

describe("when the list changes", () => {
  test("rows that are gone leave the selection", () => {
    let state = selectRange(order, selectOnly("b"), "d");
    state = reconcileSelection(["a", "b", "d", "e"], state);
    expect(selectedInOrder(["a", "b", "d", "e"], state)).toEqual(["b", "d"]);
    expect(state.focus).toBe("d");
  });

  test("nothing changed is the same object", () => {
    const state = selectOnly("b");
    expect(reconcileSelection(order, state)).toBe(state);
  });

  test("a renamed row stays selected under its new name", () => {
    const state = renameKey(selectOnly("b"), "b", "B");
    expect([...state.selected]).toEqual(["B"]);
    expect(state.anchor).toBe("B");
    expect(state.focus).toBe("B");
    const untouched = selectOnly("a");
    expect(renameKey(untouched, "b", "B")).toBe(untouched);
  });
});

describe("picking several at once", () => {
  test("what a delete could not remove stays picked, the first leading", () => {
    const state = selectKeys(["d", "b"]);
    expect(picked(state)).toEqual(["b", "d"]);
    expect(state.focus).toBe("d");
    expect(state.anchor).toBe("d");
    expect(selectKeys([])).toEqual({ selected: new Set(), anchor: null, focus: null });
  });
});
