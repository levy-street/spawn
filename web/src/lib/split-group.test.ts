import { describe, expect, test } from "bun:test";

import {
  clampSizes,
  columnCapacity,
  dragSeam,
  evenSizes,
  insertColumn,
  MAX_MEMBERS,
  MIN_COLUMN_PX,
  minShare,
  moveColumn,
  moveSeam,
  normalizeSizes,
  removeColumn,
  replaceColumn,
  runShares,
  seamPosition,
  toGroup,
  visibleRun,
  withRunShares,
} from "./split-group";

/** Shares compared to the precision a pixel cares about, not to the last ulp. */
function expectShares(actual: readonly number[], expected: readonly number[]): void {
  expect(actual.length).toBe(expected.length);
  for (const [index, share] of expected.entries()) expect(actual[index]).toBeCloseTo(share, 9);
}

function total(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

describe("minShare", () => {
  test("two columns stop where the single seam always stopped", () => {
    expect(minShare(2)).toBe(0.25);
  });

  test("more columns may each go narrower, to half an even share", () => {
    expect(minShare(3)).toBeCloseTo(1 / 6, 9);
    expect(minShare(4)).toBe(0.125);
  });
});

describe("clampSizes", () => {
  test("leaves shares that are already inside the bounds alone", () => {
    expectShares(clampSizes([0.3, 0.7]), [0.3, 0.7]);
    expectShares(clampSizes([0.25, 0.25, 0.5]), [0.25, 0.25, 0.5]);
  });

  test("lifts a column to its floor and takes the difference from the rest in proportion", () => {
    expectShares(clampSizes([0.1, 0.9]), [0.25, 0.75]);
    // Four columns, one squeezed to almost nothing: it comes back to an
    // eighth, and the other three give that up in proportion to their width.
    const clamped = clampSizes([0.01, 0.33, 0.33, 0.33]);
    expect(clamped[0]).toBeCloseTo(0.125, 9);
    expect(total(clamped)).toBeCloseTo(1, 9);
    expect(clamped[1]).toBeCloseTo(clamped[2] ?? 0, 9);
  });

  test("a lift that pushes a neighbour under the floor pins that one too", () => {
    const clamped = clampSizes([0.01, 0.13, 0.86]);
    expect(clamped[0]).toBeCloseTo(1 / 6, 9);
    expect(clamped[1]).toBeCloseTo(1 / 6, 9);
    expect(total(clamped)).toBeCloseTo(1, 9);
  });

  test("scales anything to sum to one, and gives up evenly on nothing", () => {
    expectShares(clampSizes([1, 3]), [0.25, 0.75]);
    expectShares(clampSizes([0, 0, 0]), evenSizes(3));
  });
});

describe("normalizeSizes", () => {
  test("keeps usable shares, scaled and held off the floor", () => {
    expectShares(normalizeSizes([2, 2, 4], 3), [0.25, 0.25, 0.5]);
    expectShares(normalizeSizes([0.9, 0.1], 2), [0.75, 0.25]);
  });

  test("anything else is an even split", () => {
    for (const garbage of [null, undefined, "wide", {}, [0.5], [0.5, "x"], [0.5, -1], [0, 1]]) {
      expectShares(normalizeSizes(garbage, 2), [0.5, 0.5]);
    }
    expectShares(normalizeSizes([Number.NaN, 1, 1], 3), evenSizes(3));
  });
});

describe("toGroup", () => {
  test("two to four different workspaces are a group", () => {
    expect(toGroup(["a", "b"], [0.3, 0.7])?.members).toEqual(["a", "b"]);
    expect(toGroup(["a", "b", "c"], null)?.members).toEqual(["a", "b", "c"]);
    expect(toGroup(["a", "b", "c", "d"], null)?.members).toEqual(["a", "b", "c", "d"]);
  });

  test("a group with no usable widths starts even", () => {
    expectShares(toGroup(["a", "b", "c"], "wide")?.sizes ?? [], evenSizes(3));
  });

  test("anything that is not an arrangement is no group at all", () => {
    for (const members of [
      null,
      "a,b",
      [],
      ["a"],
      ["a", "a"],
      ["a", ""],
      ["a", 7],
      ["a", "b", "c", "d", "e"],
    ]) {
      expect(toGroup(members, null)).toBeNull();
    }
  });
});

describe("insertColumn", () => {
  const two = { members: ["a", "b"], sizes: [0.5, 0.5] };

  test("one workspace becomes two at an even seam, on either side", () => {
    const alone = { members: ["a"], sizes: [1] };
    expect(insertColumn(alone, "b", 0)).toEqual({ members: ["b", "a"], sizes: [0.5, 0.5] });
    expect(insertColumn(alone, "b", 1)).toEqual({ members: ["a", "b"], sizes: [0.5, 0.5] });
  });

  test("a newcomer goes where it is put: front, between, or end", () => {
    expect(insertColumn(two, "c", 0)?.members).toEqual(["c", "a", "b"]);
    expect(insertColumn(two, "c", 1)?.members).toEqual(["a", "c", "b"]);
    expect(insertColumn(two, "c", 2)?.members).toEqual(["a", "b", "c"]);
    expectShares(insertColumn(two, "c", 1)?.sizes ?? [], evenSizes(3));
  });

  test("the newcomer takes an even share and the others give it up in proportion", () => {
    // A seam the user moved stays where it was relative to its neighbours.
    const next = insertColumn({ members: ["a", "b"], sizes: [0.7, 0.3] }, "c", 2);
    expectShares(next?.sizes ?? [], [0.7 * (2 / 3), 0.3 * (2 / 3), 1 / 3]);
  });

  test("grows to four and no further", () => {
    const three = insertColumn(two, "c", 2);
    const four = three ? insertColumn(three, "d", 3) : null;
    expect(four?.members).toEqual(["a", "b", "c", "d"]);
    expectShares(four?.sizes ?? [], evenSizes(4));
    expect(four ? insertColumn(four, "e", 0) : "missing").toBeNull();
    expect(four?.members.length).toBe(MAX_MEMBERS);
  });

  test("a workspace already in the window is not added twice", () => {
    expect(insertColumn(two, "a", 2)).toBeNull();
    expect(insertColumn(two, "", 2)).toBeNull();
  });
});

describe("removeColumn", () => {
  const four = { members: ["a", "b", "c", "d"], sizes: [0.4, 0.2, 0.2, 0.2] };

  test("takes out a column from any position and shares its width back in proportion", () => {
    expect(removeColumn(four, "a").members).toEqual(["b", "c", "d"]);
    expectShares(removeColumn(four, "a").sizes, evenSizes(3));
    expect(removeColumn(four, "b").members).toEqual(["a", "c", "d"]);
    expectShares(removeColumn(four, "b").sizes, [0.5, 0.25, 0.25]);
    expect(removeColumn(four, "c").members).toEqual(["a", "b", "d"]);
    expect(removeColumn(four, "d").members).toEqual(["a", "b", "c"]);
    expectShares(removeColumn(four, "d").sizes, [0.5, 0.25, 0.25]);
  });

  test("two less one is one column, filling the window", () => {
    expect(removeColumn({ members: ["a", "b"], sizes: [0.3, 0.7] }, "a")).toEqual({
      members: ["b"],
      sizes: [1],
    });
  });

  test("a workspace that is not a column changes nothing", () => {
    expect(removeColumn(four, "z")).toBe(four);
  });
});

describe("replaceColumn", () => {
  const three = { members: ["a", "b", "c"], sizes: [0.5, 0.25, 0.25] };

  test("a workspace from outside displaces the occupant, and the column keeps its width", () => {
    expect(replaceColumn(three, 1, "z")).toEqual({
      members: ["a", "z", "c"],
      sizes: [0.5, 0.25, 0.25],
    });
  });

  test("a member dropped on another column trades places with its occupant", () => {
    expect(replaceColumn(three, 0, "c")?.members).toEqual(["c", "b", "a"]);
  });

  test("a workspace already in that column is no change", () => {
    expect(replaceColumn(three, 2, "c")).toBeNull();
    expect(replaceColumn(three, 7, "z")).toBeNull();
  });
});

describe("moveColumn", () => {
  const four = { members: ["a", "b", "c", "d"], sizes: [0.4, 0.2, 0.2, 0.2] };

  test("a member moves and the ones between shuffle over; the seams stay put", () => {
    expect(moveColumn(four, "a", 2)).toEqual({
      members: ["b", "c", "a", "d"],
      sizes: [0.4, 0.2, 0.2, 0.2],
    });
    expect(moveColumn(four, "d", 0)?.members).toEqual(["d", "a", "b", "c"]);
  });

  test("with two columns, moving is the two trading places", () => {
    expect(moveColumn({ members: ["a", "b"], sizes: [0.3, 0.7] }, "a", 1)).toEqual({
      members: ["b", "a"],
      sizes: [0.3, 0.7],
    });
  });

  test("already there, or not a member, is no move", () => {
    expect(moveColumn(four, "b", 1)).toBeNull();
    expect(moveColumn(four, "z", 1)).toBeNull();
  });
});

describe("moveSeam", () => {
  test("two columns: the seam lands where the pointer is, within a quarter of either edge", () => {
    expectShares(moveSeam([0.5, 0.5], 0, 0.6), [0.6, 0.4]);
    expectShares(moveSeam([0.5, 0.5], 0, 0), [0.25, 0.75]);
    expectShares(moveSeam([0.5, 0.5], 0, 1), [0.75, 0.25]);
    expectShares(moveSeam([0.5, 0.5], 0, -4), [0.25, 0.75]);
  });

  test("only the two neighbours of the seam change; every other seam stays where it was", () => {
    const sizes = [0.25, 0.25, 0.25, 0.25];
    const second = moveSeam(sizes, 1, 0.6);
    expectShares(second, [0.25, 0.35, 0.15, 0.25]);
    expect(seamPosition(second, 0)).toBeCloseTo(0.25, 9);
    expect(seamPosition(second, 2)).toBeCloseTo(0.75, 9);

    const last = moveSeam(second, 2, 0.95);
    // Held at the right-hand column's floor of an eighth.
    expectShares(last, [0.25, 0.35, 0.275, 0.125]);
  });

  test("a seam cannot push a neighbour past its floor however far the pointer goes", () => {
    expectShares(moveSeam([1 / 3, 1 / 3, 1 / 3], 0, 0.01), [1 / 6, 0.5, 1 / 3]);
  });

  test("a pointer that is not a number moves nothing, and nor does a seam that is not there", () => {
    expectShares(moveSeam([0.4, 0.6], 0, Number.NaN), [0.4, 0.6]);
    expectShares(moveSeam([0.4, 0.6], 1, 0.5), [0.4, 0.6]);
  });
});

describe("columnCapacity", () => {
  test("as many columns as leave each one its minimum width, from two to four", () => {
    expect(columnCapacity(MIN_COLUMN_PX * 3)).toBe(3);
    expect(columnCapacity(MIN_COLUMN_PX * 3 - 1)).toBe(2);
    expect(columnCapacity(1408)).toBe(4);
    expect(columnCapacity(5000)).toBe(4);
  });

  test("two always fit: a split of two is drawn at any width", () => {
    expect(columnCapacity(300)).toBe(2);
  });

  test("a canvas nobody has measured yet holds them all", () => {
    expect(columnCapacity(0)).toBe(4);
    expect(columnCapacity(Number.NaN)).toBe(4);
  });
});

describe("visibleRun", () => {
  test("a group that fits is drawn from its first column", () => {
    expect(visibleRun(3, 4, 2, 2)).toBe(0);
  });

  test("a window too narrow draws a run that keeps the column being worked in", () => {
    expect(visibleRun(4, 2, 0, 0)).toBe(0);
    expect(visibleRun(4, 2, 0, 3)).toBe(2);
  });

  test("the run scrolls as little as it has to, and not at all for a column already drawn", () => {
    // Showing b and c; clicking into b must not slide the window to a and b.
    expect(visibleRun(4, 2, 1, 1)).toBe(1);
    expect(visibleRun(4, 2, 1, 2)).toBe(1);
    expect(visibleRun(4, 2, 1, 3)).toBe(2);
    expect(visibleRun(4, 2, 1, 0)).toBe(0);
  });

  test("a stale start is held inside the group", () => {
    expect(visibleRun(3, 2, 9, -1)).toBe(1);
  });
});

describe("runShares and withRunShares", () => {
  const sizes = [0.4, 0.2, 0.2, 0.2];

  test("the drawn run fills the canvas between its own columns", () => {
    expectShares(runShares(sizes, 1, 2), [0.5, 0.5]);
    expectShares(runShares(sizes, 0, 4), sizes);
  });

  test("a seam moved inside the run leaves the columns outside it alone", () => {
    const moved = withRunShares(sizes, 1, [0.75, 0.25]);
    expectShares(moved, [0.4, 0.3, 0.1, 0.2]);
    expect(total(moved)).toBeCloseTo(1, 9);
  });
});

describe("dragSeam", () => {
  /** Each column's width in pixels, as the window will draw `sizes` across `width`. */
  function pixels(sizes: readonly number[], width: number): number[] {
    return sizes.map((share) => Math.round(share * width));
  }

  test("four columns: a seam stops where a column would drop under the minimum width", () => {
    // 1416px holds four; a seam dragged as far left as it goes used to stop
    // at an eighth of the canvas, 177px.
    const four = [0.25, 0.25, 0.25, 0.25];
    const dragged = dragSeam(four, 0, 4, 0, 0, 1416);
    expect(Math.min(...pixels(dragged, 1416))).toBeGreaterThanOrEqual(MIN_COLUMN_PX);
    expect(pixels(dragged, 1416)[0]).toBe(MIN_COLUMN_PX);
    // The other way, the column to its right stops there instead.
    const back = dragSeam(four, 0, 4, 0, 1, 1416);
    expect(pixels(back, 1416)[1]).toBe(MIN_COLUMN_PX);
  });

  test("three columns hold the minimum too, and a canvas with just room for them all holds them even", () => {
    const three = [1 / 3, 1 / 3, 1 / 3];
    expect(Math.min(...pixels(dragSeam(three, 0, 3, 1, 0.9, 1200), 1200))).toBe(MIN_COLUMN_PX);
    expect(pixels(dragSeam(three, 0, 3, 1, 0.9, 3 * MIN_COLUMN_PX), 3 * MIN_COLUMN_PX)).toEqual([
      280, 280, 280,
    ]);
  });

  test("a pair keeps the quarter it always had, at any width", () => {
    expectShares(dragSeam([0.5, 0.5], 0, 2, 0, 0, 1416), [0.25, 0.75]);
    expectShares(dragSeam([0.5, 0.5], 0, 2, 0, 0, 500), [0.25, 0.75]);
    expectShares(dragSeam([0.5, 0.5], 0, 2, 0, 0.6, 500), [0.6, 0.4]);
  });

  test("on a folded window the columns it does not draw keep their widths", () => {
    // Four in the group, the first two drawn. The seam between them dragged
    // hard left used to leave it at 42% and squeeze the two hidden columns,
    // because the whole group's floor pulled the drawn one back up.
    const sizes = [0.125, 0.125, 0.375, 0.375];
    const dragged = normalizeSizes(dragSeam(sizes, 0, 2, 0, 0.1, 600), 4);
    expect(dragged[2]).toBeCloseTo(0.375, 9);
    expect(dragged[3]).toBeCloseTo(0.375, 9);
    // And what the window then draws is where the seam was left.
    const drawn = runShares(dragged, 0, 2);
    const once = runShares(dragSeam(sizes, 0, 2, 0, 0.1, 600), 0, 2);
    expect(drawn[0]).toBeCloseTo(once[0] ?? 0, 9);
  });
});
