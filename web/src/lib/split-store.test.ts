import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  isMember,
  normalizeSplit,
  readStoredSplit,
  SPLIT_STORAGE_KEY,
  splitFor,
  splitStore,
} from "./split-store";
import { normalizeSplit as previousBuildReads } from "./split-store-pair-reader.fixture";

/**
 * The stateful half is a module singleton, so every test here starts from the
 * unsplit default rather than from whatever the last one left behind. Bun runs
 * a file's tests in order, which is what makes that a reset and not a hope.
 */
function reset(): void {
  splitStore.clear();
  splitStore.setRendered([]);
}

/**
 * The reader guards on `window` and then reads `window.localStorage`, so both
 * have to be present. Bun's test runtime has no DOM, which is the point: this
 * stubs exactly the two globals under test and restores them afterwards.
 */
function withStorage(storage: Partial<Storage> | null, run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: storage },
    configurable: true,
    writable: true,
  });
  try {
    run();
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

function fakeStorage(initial: Record<string, string> = {}): Partial<Storage> {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

const NO_SPLIT = { group: null, rendered: [], activeId: null, heading: null };

/** The members of the group the store holds, or null. */
function members(): readonly string[] | null {
  return splitStore.get().group?.members ?? null;
}

/** The group's widths, compared to the precision a pixel cares about. */
function expectSizes(expected: readonly number[]): void {
  const actual = splitStore.get().group?.sizes ?? [];
  expect(actual.length).toBe(expected.length);
  for (const [index, share] of expected.entries()) expect(actual[index]).toBeCloseTo(share, 9);
}

describe("splitFor", () => {
  const group = { members: ["a", "b", "c"], sizes: [0.4, 0.3, 0.3] };

  test("any member of the group draws the whole group", () => {
    expect(splitFor(group, "a")).toBe(group);
    // A column other than the first, opened directly: the same window, with
    // the address bar about another column of it.
    expect(splitFor(group, "b")).toBe(group);
    expect(splitFor(group, "c")).toBe(group);
  });

  test("a workspace outside the group draws itself, and parks the group", () => {
    expect(splitFor(group, "z")).toBeNull();
    expect(splitFor(group, null)).toBeNull();
    expect(splitFor(null, "a")).toBeNull();
  });

  test("isMember answers the same question for one workspace", () => {
    expect(isMember(group, "c")).toBe(true);
    expect(isMember(group, "z")).toBe(false);
    expect(isMember(null, "a")).toBe(false);
  });
});

describe("normalizeSplit", () => {
  test("survives anything storage could hand back", () => {
    for (const garbage of [
      null,
      undefined,
      7,
      "split",
      [],
      ["a", "b"],
      true,
      { ratio: "half" },
      { members: "a,b" },
      { members: ["a"] },
      { members: ["a", "a"] },
      { members: ["a", "b", "c", "d", "e"] },
      { members: ["a", 3] },
    ]) {
      expect(normalizeSplit(garbage)).toEqual(NO_SPLIT);
    }
  });

  test("restores a group of two, three or four with the widths it was saved at", () => {
    expect(normalizeSplit({ members: ["a", "b", "c"], sizes: [0.5, 0.25, 0.25] })).toEqual({
      group: { members: ["a", "b", "c"], sizes: [0.5, 0.25, 0.25] },
      rendered: [],
      activeId: null,
      heading: null,
    });
    expect(normalizeSplit({ members: ["a", "b", "c", "d"] }).group?.sizes).toEqual([
      0.25, 0.25, 0.25, 0.25,
    ]);
  });

  test("widths that do not describe the group start it even rather than dropping it", () => {
    expect(normalizeSplit({ members: ["a", "b"], sizes: [1] }).group).toEqual({
      members: ["a", "b"],
      sizes: [0.5, 0.5],
    });
  });

  test("a pair saved by the two-workspace shape loads as the same split: same order, same seam", () => {
    expect(normalizeSplit({ primaryId: "a", secondaryId: "b", ratio: 0.3 })).toEqual({
      group: { members: ["a", "b"], sizes: [0.3, 0.7] },
      rendered: [],
      activeId: null,
      heading: null,
    });
    // The right-hand one first is a different window, and stays one.
    expect(normalizeSplit({ primaryId: "b", secondaryId: "a", ratio: 0.5 }).group?.members).toEqual(
      ["b", "a"],
    );
  });

  test("an old pair's ratio is held to the bounds the seam always had", () => {
    expect(normalizeSplit({ primaryId: "a", secondaryId: "b", ratio: 0.9 }).group?.sizes).toEqual([
      0.75, 0.25,
    ]);
    expect(normalizeSplit({ primaryId: "a", secondaryId: "b", ratio: -2 }).group?.sizes).toEqual([
      0.25, 0.75,
    ]);
    expect(normalizeSplit({ primaryId: "a", secondaryId: "b" }).group?.sizes).toEqual([0.5, 0.5]);
    expect(normalizeSplit({ primaryId: "a", secondaryId: "b", ratio: "x" }).group?.sizes).toEqual([
      0.5, 0.5,
    ]);
  });

  test("half an old pair is not an arrangement", () => {
    // Including what the shape before that wrote, which named the second
    // workspace and left the first to the route.
    expect(normalizeSplit({ secondaryId: "b" }).group).toBeNull();
    expect(normalizeSplit({ primaryId: "a" }).group).toBeNull();
    expect(normalizeSplit({ primaryId: "a", secondaryId: "" }).group).toBeNull();
    expect(normalizeSplit({ primaryId: 12, secondaryId: "b" }).group).toBeNull();
    expect(normalizeSplit({ primaryId: "a", secondaryId: "a" }).group).toBeNull();
  });

  test("never restores what is drawn or which column was last typed in", () => {
    // A reload starts at whichever column the URL names, so a stored active
    // member would hand the keyboard to a column nobody had touched yet.
    const loaded = normalizeSplit({
      members: ["a", "b"],
      sizes: [0.5, 0.5],
      activeId: "b",
      rendered: ["a", "b"],
    });
    expect(loaded.activeId).toBeNull();
    expect(loaded.rendered).toEqual([]);
  });
});

describe("readStoredSplit", () => {
  test("restores a written arrangement", () => {
    withStorage(
      fakeStorage({ [SPLIT_STORAGE_KEY]: '{"members":["a","b","c"],"sizes":[0.2,0.4,0.4]}' }),
      () => {
        expect(readStoredSplit().group).toEqual({
          members: ["a", "b", "c"],
          sizes: [0.2, 0.4, 0.4],
        });
      },
    );
  });

  test("an existing user's stored pair comes up as the split they left", () => {
    withStorage(
      fakeStorage({ [SPLIT_STORAGE_KEY]: '{"primaryId":"a","secondaryId":"b","ratio":0.3}' }),
      () => {
        expect(readStoredSplit()).toEqual({
          group: { members: ["a", "b"], sizes: [0.3, 0.7] },
          rendered: [],
          activeId: null,
          heading: null,
        });
      },
    );
  });

  test("a single workspace is the answer when storage is empty, corrupt, or refusing", () => {
    withStorage(fakeStorage(), () => {
      expect(readStoredSplit().group).toBeNull();
    });
    withStorage(fakeStorage({ [SPLIT_STORAGE_KEY]: "{not json" }), () => {
      expect(readStoredSplit()).toEqual(NO_SPLIT);
    });
    withStorage(fakeStorage({ [SPLIT_STORAGE_KEY]: '{"members":{"a":1}}' }), () => {
      expect(readStoredSplit()).toEqual(NO_SPLIT);
    });
    withStorage(
      {
        getItem: () => {
          throw new Error("blocked");
        },
      },
      () => {
        expect(readStoredSplit()).toEqual(NO_SPLIT);
      },
    );
  });
});

describe("splitStore.arrange", () => {
  test("arranges a group and notifies once per change", () => {
    reset();
    let notified = 0;
    const unsubscribe = splitStore.subscribe(() => {
      notified += 1;
    });

    splitStore.arrange(["a", "b"]);
    expect(splitStore.get().group).toEqual({ members: ["a", "b"], sizes: [0.5, 0.5] });
    expect(notified).toBe(1);

    // Re-asserting the same group changes nothing, so nothing re-renders.
    splitStore.arrange(["a", "b"]);
    expect(notified).toBe(1);

    unsubscribe();
    splitStore.clear();
    expect(notified).toBe(1);
  });

  test("holds two, three or four workspaces, at the widths it is given", () => {
    reset();
    splitStore.arrange(["a", "b", "c"], [0.5, 0.25, 0.25]);
    expect(splitStore.get().group).toEqual({
      members: ["a", "b", "c"],
      sizes: [0.5, 0.25, 0.25],
    });
    splitStore.arrange(["a", "b", "c", "d"]);
    expect(members()).toEqual(["a", "b", "c", "d"]);
    expect(splitStore.get().group?.sizes).toEqual([0.25, 0.25, 0.25, 0.25]);
  });

  test("refuses a workspace beside itself, and refuses anything that is not a split", () => {
    reset();
    splitStore.arrange(["a", "a"]);
    expect(members()).toBeNull();
    splitStore.arrange(["a"]);
    expect(members()).toBeNull();
    splitStore.arrange(["", "b"]);
    expect(members()).toBeNull();
    splitStore.arrange(["a", "b", "c", "d", "e"]);
    expect(members()).toBeNull();
  });

  test("the same workspaces in another order is a different window", () => {
    reset();
    splitStore.arrange(["a", "b", "c"]);
    splitStore.arrange(["c", "a", "b"]);
    expect(members()).toEqual(["c", "a", "b"]);
  });

  test("rearranging leaves the seams where the user put them", () => {
    reset();
    splitStore.arrange(["a", "b"]);
    splitStore.setSizes([0.65, 0.35]);
    splitStore.arrange(["a", "c"]);
    expect(splitStore.get().group).toEqual({ members: ["a", "c"], sizes: [0.65, 0.35] });
    // A different number of columns is a different shape, and starts even.
    splitStore.arrange(["a", "c", "d"]);
    expect(splitStore.get().group?.sizes).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  test("keeps the active member while it is still one", () => {
    reset();
    splitStore.arrange(["a", "b", "c"]);
    splitStore.setActive("b");
    splitStore.arrange(["b", "a", "c"]);
    expect(splitStore.get().activeId).toBe("b");
    splitStore.arrange(["a", "c"]);
    expect(splitStore.get().activeId).toBeNull();
  });
});

describe("splitStore.setSizes", () => {
  test("normalises and holds every column off its floor, so callers may hand it raw arithmetic", () => {
    reset();
    splitStore.arrange(["a", "b"]);
    splitStore.setSizes([-2, 1]);
    expect(splitStore.get().group?.sizes).toEqual([0.5, 0.5]);
    splitStore.setSizes([0.9, 0.1]);
    expectSizes([0.75, 0.25]);
    splitStore.setSizes([3, 1]);
    expect(splitStore.get().group?.sizes).toEqual([0.75, 0.25]);
  });

  test("a resize of one seam in four keeps the others", () => {
    reset();
    splitStore.arrange(["a", "b", "c", "d"]);
    splitStore.setSizes([0.25, 0.35, 0.15, 0.25]);
    expectSizes([0.25, 0.35, 0.15, 0.25]);
  });

  test("widths for the wrong number of columns start the group even", () => {
    reset();
    splitStore.arrange(["a", "b", "c"], [0.5, 0.25, 0.25]);
    splitStore.setSizes([0.5, 0.5]);
    expect(splitStore.get().group?.sizes).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  test("no split, no widths", () => {
    reset();
    splitStore.setSizes([0.5, 0.5]);
    expect(splitStore.get().group).toBeNull();
  });
});

describe("splitStore.setActive", () => {
  test("the active column is a split-only fact, and only a member can be it", () => {
    reset();
    splitStore.setActive("b");
    expect(splitStore.get().activeId).toBeNull();
    splitStore.arrange(["a", "b", "c"]);
    splitStore.setActive("c");
    expect(splitStore.get().activeId).toBe("c");
    splitStore.setActive("z");
    expect(splitStore.get().activeId).toBe("c");
  });
});

describe("splitStore.remove", () => {
  test("one member steps out of four from any position and the rest stay split", () => {
    for (const [leaving, rest] of [
      ["a", ["b", "c", "d"]],
      ["b", ["a", "c", "d"]],
      ["c", ["a", "b", "d"]],
      ["d", ["a", "b", "c"]],
    ] as const) {
      reset();
      splitStore.arrange(["a", "b", "c", "d"]);
      splitStore.remove(leaving, "z");
      expect(members()).toEqual([...rest]);
    }
  });

  test("its width is shared back among the columns that stay", () => {
    reset();
    splitStore.arrange(["a", "b", "c"], [0.5, 0.25, 0.25]);
    splitStore.remove("a", null);
    expect(splitStore.get().group?.sizes).toEqual([0.5, 0.5]);
  });

  test("a pair that loses one is one workspace again", () => {
    reset();
    splitStore.arrange(["a", "b"]);
    splitStore.remove("b", "a");
    expect(splitStore.get().group).toBeNull();
    expect(splitStore.get().activeId).toBeNull();
  });

  test("a route onto the leaving workspace moves to the column that takes its place", () => {
    reset();
    splitStore.arrange(["a", "b", "c"]);
    // Its right-hand neighbour slides into its slot...
    expect(splitStore.remove("b", "b")).toBe("c");
    // ...or, at the end of the row, its left-hand one does.
    reset();
    splitStore.arrange(["a", "b", "c"]);
    expect(splitStore.remove("c", "c")).toBe("b");
    // A pair's survivor is the window, as "remove from split" always did.
    reset();
    splitStore.arrange(["a", "b"]);
    expect(splitStore.remove("a", "a")).toBe("b");
  });

  test("a route on another column, or off the split, stays where it is", () => {
    reset();
    splitStore.arrange(["a", "b", "c"]);
    expect(splitStore.remove("b", "a")).toBeNull();
    expect(splitStore.remove("a", "z")).toBeNull();
    expect(members()).toBeNull();
  });

  test("the keyboard passes to the column that takes the active one's place", () => {
    reset();
    splitStore.arrange(["a", "b", "c"]);
    splitStore.setActive("b");
    splitStore.remove("b", null);
    expect(splitStore.get().activeId).toBe("c");
    reset();
    splitStore.arrange(["a", "b", "c"]);
    splitStore.setActive("a");
    splitStore.remove("c", null);
    expect(splitStore.get().activeId).toBe("a");
  });

  test("a workspace that is not a member changes nothing", () => {
    reset();
    splitStore.arrange(["a", "b"]);
    expect(splitStore.remove("z", "z")).toBeNull();
    expect(members()).toEqual(["a", "b"]);
  });
});

describe("splitStore.unsplit", () => {
  test("keeping the column you are already on moves nobody", () => {
    reset();
    splitStore.arrange(["a", "b", "c"]);
    splitStore.setActive("c");
    expect(splitStore.unsplit("a", "a")).toBeNull();
    expect(splitStore.get().group).toBeNull();
    expect(splitStore.get().activeId).toBeNull();
  });

  test("keeping another column hands the caller somewhere to go", () => {
    reset();
    splitStore.arrange(["a", "b", "c", "d"]);
    // Routed at one column and keeping another — the address bar has to
    // follow, or it would be about a workspace no longer on screen.
    expect(splitStore.unsplit("c", "a")).toBe("c");
    expect(splitStore.get().group).toBeNull();
  });

  test("dissolving a parked group leaves the page you are on alone", () => {
    reset();
    splitStore.arrange(["a", "b"]);
    // Working in some other workspace: the split is only a row in the rail
    // from here, and putting it away is not a reason to navigate.
    expect(splitStore.unsplit("a", "z")).toBeNull();
    expect(splitStore.get().group).toBeNull();
  });
});

describe("splitStore.followRoute", () => {
  test("arriving at a column hands it the keyboard", () => {
    reset();
    splitStore.arrange(["a", "b", "c"]);
    splitStore.followRoute("c");
    expect(splitStore.get().activeId).toBe("c");
    splitStore.followRoute("a");
    expect(splitStore.get().activeId).toBe("a");
  });

  test("arriving anywhere else lets go of it", () => {
    reset();
    splitStore.arrange(["a", "b"]);
    splitStore.setActive("b");
    splitStore.followRoute("z");
    expect(splitStore.get().activeId).toBeNull();
    // And the arrangement itself is untouched: it is parked, not dismantled.
    expect(members()).toEqual(["a", "b"]);
  });
});

describe("splitStore.reconcile", () => {
  test("a pair whose workspace is no longer listed is one workspace again", () => {
    reset();
    splitStore.arrange(["a", "b"]);
    splitStore.reconcile(new Set(["a"]));
    expect(splitStore.get().group).toBeNull();

    // Either end of it, not just the second one.
    splitStore.arrange(["a", "b"]);
    splitStore.reconcile(new Set(["b"]));
    expect(splitStore.get().group).toBeNull();
  });

  test("a bigger group loses only the workspaces that stopped existing", () => {
    reset();
    splitStore.arrange(["a", "b", "c", "d"], [0.5, 0.25, 0.125, 0.125]);
    splitStore.setActive("d");
    splitStore.reconcile(new Set(["a", "c", "d", "x"]));
    expect(members()).toEqual(["a", "c", "d"]);
    expectSizes([2 / 3, 1 / 6, 1 / 6]);
    expect(splitStore.get().activeId).toBe("d");

    // Down to one survivor is no split at all.
    splitStore.reconcile(new Set(["c"]));
    expect(splitStore.get().group).toBeNull();
    expect(splitStore.get().activeId).toBeNull();
  });

  test("a group whose workspaces all still exist is left alone", () => {
    reset();
    splitStore.arrange(["a", "b", "c"]);
    splitStore.reconcile(new Set(["a", "b", "c", "d"]));
    expect(members()).toEqual(["a", "b", "c"]);
  });

  test("the column the address bar is on leaving the list names where it would go", () => {
    reset();
    splitStore.arrange(["a", "b", "c"]);
    // The list refresh got here first. It cannot tell an archive from a
    // delete — an archived workspace leaves the list too, and stays on
    // screen as its snapshot — so it names the destination without heading
    // there: the window keeps showing b until something knows b is gone.
    expect(splitStore.reconcile(new Set(["a", "c"]), "b")).toBe("c");
    expect(members()).toEqual(["a", "c"]);
    expect(splitStore.get().heading).toBeNull();
    // b's own 404 is that something. It agrees on where, rather than picking
    // by position, and the window draws it while the route catches up.
    expect(splitStore.remove("b", "b")).toBe("c");
    expect(splitStore.get().heading).toBe("c");
  });

  test("a pair whose routed member stops existing hands the address bar to the survivor", () => {
    reset();
    splitStore.arrange(["a", "b"]);
    expect(splitStore.reconcile(new Set(["a"]), "b")).toBe("a");
    expect(splitStore.get().group).toBeNull();
  });

  test("several gone at once: the nearest survivor to its right, else to its left", () => {
    reset();
    splitStore.arrange(["a", "b", "c", "d"]);
    expect(splitStore.reconcile(new Set(["a", "d"]), "b")).toBe("d");
    reset();
    splitStore.arrange(["a", "b", "c", "d"]);
    expect(splitStore.reconcile(new Set(["a", "b"]), "d")).toBe("b");
  });

  test("a member leaving that the address bar is not on moves nothing", () => {
    reset();
    splitStore.arrange(["a", "b", "c"]);
    expect(splitStore.reconcile(new Set(["a", "b"]), "a")).toBeNull();
    expect(splitStore.get().heading).toBeNull();
    expect(splitStore.reconcile(new Set(["a", "b"]), "z")).toBeNull();
  });

  test("where a departed member went is forgotten once the route arrives", () => {
    // [a, b]: a removed while the URL is on it, the route goes to b. Long
    // after, a is opened alone and deleted: it must not send the URL to b
    // again — b may be gone too, and a's own way out is /app or the next row.
    reset();
    splitStore.arrange(["a", "b"]);
    expect(splitStore.remove("a", "a")).toBe("b");
    // Until the route has arrived, a late 404 for a still agrees.
    expect(splitStore.remove("a", "a")).toBe("b");
    splitStore.followRoute("b");
    expect(splitStore.remove("a", "a")).toBeNull();
  });

  test("arriving anywhere ends the heading", () => {
    reset();
    splitStore.arrange(["a", "b", "c"]);
    splitStore.remove("b", "b");
    expect(splitStore.get().heading).toBe("c");
    splitStore.followRoute("c");
    expect(splitStore.get().heading).toBeNull();
  });

  test("a list that has not loaded yet is not evidence of anything", () => {
    reset();
    splitStore.arrange(["a", "b"]);
    splitStore.reconcile(null);
    expect(members()).toEqual(["a", "b"]);
  });
});

describe("splitStore.setRendered", () => {
  test("publishes what is drawn, separately from what is stored", () => {
    reset();
    let notified = 0;
    const unsubscribe = splitStore.subscribe(() => {
      notified += 1;
    });

    // A group parked behind some other workspace: the arrangement stands, and
    // nothing of it is on screen. Anything reading the split to decide what
    // to paint has to be able to tell those two apart.
    splitStore.arrange(["a", "b", "c"]);
    expect(members()).toEqual(["a", "b", "c"]);
    expect(splitStore.get().rendered).toEqual([]);

    splitStore.setRendered(["a", "b", "c"]);
    expect(splitStore.get().rendered).toEqual(["a", "b", "c"]);
    expect(notified).toBe(2);

    // The same columns again, as a fresh array: nothing changed.
    splitStore.setRendered(["a", "b", "c"]);
    expect(notified).toBe(2);

    // One workspace on screen is not a split, however it is reported.
    splitStore.setRendered(["a"]);
    expect(splitStore.get().rendered).toEqual([]);

    unsubscribe();
  });

  test("outlives the group, which is what a close animation needs", () => {
    reset();
    splitStore.arrange(["a", "b"]);
    splitStore.setRendered(["a", "b"]);
    splitStore.clear();
    // The container still has the outgoing column mounted and collapsing, so
    // the drawn fact stays true until it says otherwise.
    expect(splitStore.get().group).toBeNull();
    expect(splitStore.get().rendered).toEqual(["a", "b"]);
    splitStore.setRendered([]);
    expect(splitStore.get().rendered).toEqual([]);
  });
});

describe("splitStore persistence", () => {
  test("writes the arrangement and nothing about the session", () => {
    const storage = fakeStorage();
    withStorage(storage, () => {
      reset();
      splitStore.arrange(["a", "b", "c"], [0.5, 0.25, 0.25]);
      splitStore.setActive("b");
      // A fact about what is mounted right now. Restoring it would assert a
      // column was drawn before anything had been rendered.
      splitStore.setRendered(["a", "b", "c"]);
    });
    const written = JSON.parse(storage.getItem?.(SPLIT_STORAGE_KEY) ?? "");
    expect(written.members).toEqual(["a", "b", "c"]);
    expect(written.sizes).toEqual([0.5, 0.25, 0.25]);
    // Nothing about the session: what is drawn and active stay out of it.
    expect(Object.keys(written).sort()).toEqual(
      ["members", "primaryId", "ratio", "secondaryId", "sizes"].sort(),
    );
  });

  test("what it writes reads back as the same split", () => {
    const storage = fakeStorage();
    withStorage(storage, () => {
      reset();
      splitStore.arrange(["d", "a", "c", "b"], [0.5, 0.25, 0.125, 0.125]);
      expect(readStoredSplit().group).toEqual({
        members: ["d", "a", "c", "b"],
        sizes: [0.5, 0.25, 0.125, 0.125],
      });
    });
  });

  test("a build from before four columns reads what this one writes as the pair it knows", () => {
    // A rollback, or a tab still open on the previous deploy, reads storage
    // through master's own reader. It must find a split, not lose one.
    for (const [members, sizes, ratio] of [
      [["a", "b"], [0.3, 0.7], 0.3],
      [["a", "b", "c"], [0.5, 0.25, 0.25], 2 / 3],
      [["a", "b", "c", "d"], [0.25, 0.25, 0.25, 0.25], 0.5],
    ] as const) {
      const storage = fakeStorage();
      withStorage(storage, () => {
        reset();
        splitStore.arrange(members, sizes);
      });
      const written = JSON.parse(storage.getItem?.(SPLIT_STORAGE_KEY) ?? "null");
      const old = previousBuildReads(written);
      expect(old.pair).toEqual({ primaryId: "a", secondaryId: "b" });
      expect(old.ratio).toBeCloseTo(ratio, 9);
      // And this build still reads its own shape, not the pair beside it.
      expect(normalizeSplit(written).group?.members).toEqual([...members]);
    }
  });

  test("a pair round-trips through the previous build unchanged", () => {
    // Written here, read there and written back in its shape, read here
    // again: the same two workspaces in the same order at the same seam.
    const storage = fakeStorage();
    withStorage(storage, () => {
      reset();
      splitStore.arrange(["b", "a"], [0.3, 0.7]);
    });
    const old = previousBuildReads(JSON.parse(storage.getItem?.(SPLIT_STORAGE_KEY) ?? "null"));
    const rewritten = {
      primaryId: old.pair?.primaryId,
      secondaryId: old.pair?.secondaryId,
      ratio: old.ratio,
    };
    const back = normalizeSplit(rewritten).group;
    expect(back?.members).toEqual(["b", "a"]);
    expect(back?.sizes[0]).toBeCloseTo(0.3, 9);
    expect(back?.sizes[1]).toBeCloseTo(0.7, 9);
  });

  test("the previous build's reader is master's own, byte for byte", () => {
    // `git show f1ca1b86:web/src/lib/split-store.ts | sha256sum`. The fixture
    // is only evidence while it is exactly that file; this fails the moment
    // anyone edits it, even to make a test pass.
    const fixture = readFileSync(
      new URL("./split-store-pair-reader.fixture.ts", import.meta.url),
      "utf8",
    );
    const body = fixture.slice(fixture.indexOf(" */\n\n") + " */\n\n".length);
    expect(createHash("sha256").update(body).digest("hex")).toBe(
      "a9626168abb21975b42316502ef1c07604c97831765099cc21598f5d660b4e84",
    );
  });

  test("an older build that rearranges a group of three or four keeps only its first two", () => {
    // Accepted for a rollback, and stated here so nobody is surprised by it:
    // that build only knows a pair, so the first change it makes — a seam
    // drag, a swap — writes the pair back and the rest of the group is gone.
    const storage = fakeStorage();
    withStorage(storage, () => {
      reset();
      splitStore.arrange(["a", "b", "c", "d"], [0.25, 0.25, 0.25, 0.25]);
    });
    const old = previousBuildReads(JSON.parse(storage.getItem?.(SPLIT_STORAGE_KEY) ?? "null"));
    const writtenBack = {
      primaryId: old.pair?.primaryId,
      secondaryId: old.pair?.secondaryId,
      ratio: old.ratio,
    };
    expect(normalizeSplit(writtenBack).group?.members).toEqual(["a", "b"]);
  });

  test("no split is nothing stored", () => {
    const storage = fakeStorage({ [SPLIT_STORAGE_KEY]: '{"members":["a","b"]}' });
    withStorage(storage, () => {
      reset();
      splitStore.arrange(["a", "b"]);
      splitStore.clear();
    });
    expect(storage.getItem?.(SPLIT_STORAGE_KEY)).toBeNull();
  });

  test("a storage that refuses writes still rearranges the window", () => {
    withStorage(
      {
        getItem: () => null,
        setItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => {
          throw new Error("blocked");
        },
      },
      () => {
        reset();
        splitStore.arrange(["a", "b"]);
        expect(members()).toEqual(["a", "b"]);
      },
    );
    reset();
  });
});
