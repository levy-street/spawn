import { describe, expect, test } from "bun:test";
import {
  dropLeaving,
  type MountedColumn,
  mountColumns,
  settledColumns,
  settledShares,
  settleEntering,
} from "./split-columns";

/** Columns written as `id:state`, so a case reads as the strip it describes. */
function strip(...entries: string[]): MountedColumn[] {
  return entries.map((entry) => {
    const [id = "", state = "in"] = entry.split(":");
    return { id, state: state as MountedColumn["state"] };
  });
}

describe("mountColumns", () => {
  test("a newcomer arrives flat at its seam, wherever it was put", () => {
    expect(mountColumns(strip("a", "b"), ["a", "c", "b"])).toEqual(strip("a", "c:entering", "b"));
    expect(mountColumns(strip("a", "b"), ["c", "a", "b"])).toEqual(strip("c:entering", "a", "b"));
  });

  test("a column that goes stays mounted where it was until it has folded away", () => {
    expect(mountColumns(strip("a", "b", "c", "d"), ["a", "c", "d"])).toEqual(
      strip("a", "b:leaving", "c", "d"),
    );
    expect(mountColumns(strip("a", "b", "c"), ["b", "c"])).toEqual(strip("a:leaving", "b", "c"));
    expect(mountColumns(strip("a", "b", "c"), ["a", "b"])).toEqual(strip("a", "b", "c:leaving"));
  });

  test("a pair put back to one folds the other away, as it always did", () => {
    expect(mountColumns(strip("a", "b"), ["a"])).toEqual(strip("a", "b:leaving"));
  });

  test("moving workspaces between columns keeps every one of them mounted", () => {
    expect(mountColumns(strip("a", "b", "c"), ["c", "a", "b"])).toEqual(strip("c", "a", "b"));
  });

  test("a window that shares nothing with the last one is drawn at once", () => {
    // Navigating from a split to some other workspace, or back into a parked
    // split from outside it: a different window, not a rearranged one.
    expect(mountColumns(strip("a", "b"), ["z"])).toEqual(strip("z"));
    expect(mountColumns(strip("z"), ["a", "b", "c"])).toEqual(strip("a", "b", "c"));
  });

  test("one brought back while folding away settles from where it is", () => {
    expect(mountColumns(strip("a", "b:leaving"), ["a", "b"])).toEqual(strip("a", "b"));
  });

  test("one still waiting for its opening frame keeps waiting", () => {
    expect(mountColumns(strip("a", "b:entering"), ["a", "b", "c"])).toEqual(
      strip("a", "b:entering", "c:entering"),
    );
  });
});

describe("settleEntering and dropLeaving", () => {
  test("the opening frame sweeps arriving columns out; the end of a close takes leaving ones away", () => {
    const mixed = strip("a", "b:entering", "c:leaving");
    expect(settleEntering(mixed)).toEqual(strip("a", "b", "c:leaving"));
    expect(dropLeaving(mixed)).toEqual(strip("a", "b:entering"));
  });

  test("a first window starts settled", () => {
    expect(settledColumns(["a", "b"])).toEqual(strip("a", "b"));
  });
});

describe("settledShares", () => {
  test("settled columns take their own widths", () => {
    expect(settledShares(strip("a", "b", "c"), ["a", "b", "c"], [0.5, 0.25, 0.25])).toEqual(
      new Map([
        ["a", 0.5],
        ["b", 0.25],
        ["c", 0.25],
      ]),
    );
  });

  test("while a column arrives or goes, the others keep the canvas full between them", () => {
    // Before the opening frame the window looks exactly as it did.
    expect(
      settledShares(strip("a", "c:entering", "b"), ["a", "c", "b"], [1 / 3, 1 / 3, 1 / 3]),
    ).toEqual(
      new Map([
        ["a", 0.5],
        ["b", 0.5],
      ]),
    );
    expect(settledShares(strip("a", "b:leaving"), ["a"], [1])).toEqual(new Map([["a", 1]]));
  });
});
