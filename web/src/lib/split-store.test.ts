import { describe, expect, test } from "bun:test";

import {
  clampRatio,
  DEFAULT_RATIO,
  MAX_RATIO,
  MIN_RATIO,
  memberSide,
  normalizeSplit,
  readStoredSplit,
  SPLIT_STORAGE_KEY,
  splitFor,
  splitStore,
} from "./split-store";

/**
 * The stateful half is a module singleton, so every test here starts from the
 * unsplit default rather than from whatever the last one left behind. Bun runs
 * a file's tests in order, which is what makes that a reset and not a hope.
 */
function reset(): void {
  splitStore.clear();
  splitStore.setRendered(null);
  splitStore.setRatio(DEFAULT_RATIO);
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

describe("clampRatio", () => {
  test("holds both halves wide enough to still be a grid", () => {
    expect(clampRatio(0)).toBe(MIN_RATIO);
    expect(clampRatio(1)).toBe(MAX_RATIO);
    expect(clampRatio(-4)).toBe(MIN_RATIO);
    expect(clampRatio(0.5)).toBe(0.5);
    expect(clampRatio(MIN_RATIO)).toBe(MIN_RATIO);
    expect(clampRatio(MAX_RATIO)).toBe(MAX_RATIO);
  });

  test("falls back to an even split rather than propagating a non-number", () => {
    expect(clampRatio(Number.NaN)).toBe(DEFAULT_RATIO);
    expect(clampRatio(Number.POSITIVE_INFINITY)).toBe(DEFAULT_RATIO);
    expect(clampRatio(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_RATIO);
  });
});

describe("memberSide", () => {
  const pair = { primaryId: "a", secondaryId: "b" };

  test("names the half a workspace holds", () => {
    expect(memberSide(pair, "a")).toBe("primary");
    expect(memberSide(pair, "b")).toBe("secondary");
  });

  test("a workspace outside the pair is in neither half", () => {
    expect(memberSide(pair, "c")).toBeNull();
    expect(memberSide(pair, null)).toBeNull();
    expect(memberSide(null, "a")).toBeNull();
  });
});

describe("splitFor", () => {
  const pair = { primaryId: "a", secondaryId: "b" };

  test("either member of the pair draws the whole pair", () => {
    expect(splitFor(pair, "a")).toEqual(pair);
    // The right-hand workspace, opened directly: the same window, with the
    // address bar about the other half of it.
    expect(splitFor(pair, "b")).toEqual(pair);
  });

  test("a third workspace draws itself, and parks the pair", () => {
    expect(splitFor(pair, "c")).toBeNull();
    expect(splitFor(pair, null)).toBeNull();
    expect(splitFor(null, "a")).toBeNull();
  });
});

describe("normalizeSplit", () => {
  test("survives anything storage could hand back", () => {
    for (const garbage of [null, undefined, 7, "split", [], true, { ratio: "half" }]) {
      expect(normalizeSplit(garbage)).toEqual({
        pair: null,
        renderedSecondaryId: null,
        ratio: DEFAULT_RATIO,
        activeSide: "primary",
      });
    }
  });

  test("keeps a usable pair and clamps the ratio it came with", () => {
    expect(normalizeSplit({ primaryId: "a", secondaryId: "b", ratio: 0.9 })).toEqual({
      pair: { primaryId: "a", secondaryId: "b" },
      renderedSecondaryId: null,
      ratio: MAX_RATIO,
      activeSide: "primary",
    });
  });

  test("half an arrangement is not one", () => {
    // Including what the older storage shape wrote, which named the second
    // workspace and left the first to the route.
    expect(normalizeSplit({ secondaryId: "b" }).pair).toBeNull();
    expect(normalizeSplit({ primaryId: "a" }).pair).toBeNull();
    expect(normalizeSplit({ primaryId: "a", secondaryId: "" }).pair).toBeNull();
    expect(normalizeSplit({ primaryId: 12, secondaryId: "b" }).pair).toBeNull();
    expect(normalizeSplit({ primaryId: "a", secondaryId: "a" }).pair).toBeNull();
  });

  test("never restores which half was last typed in", () => {
    // A reload starts at whichever half the URL names, so a stored
    // "secondary" would hand the keyboard to a half nobody had touched yet.
    expect(
      normalizeSplit({ primaryId: "a", secondaryId: "b", activeSide: "secondary" }).activeSide,
    ).toBe("primary");
  });
});

describe("readStoredSplit", () => {
  test("restores a written arrangement", () => {
    withStorage(
      fakeStorage({ [SPLIT_STORAGE_KEY]: '{"primaryId":"a","secondaryId":"b","ratio":0.3}' }),
      () => {
        expect(readStoredSplit()).toEqual({
          pair: { primaryId: "a", secondaryId: "b" },
          renderedSecondaryId: null,
          ratio: 0.3,
          activeSide: "primary",
        });
      },
    );
  });

  test("a single workspace is the answer when storage is empty, corrupt, or refusing", () => {
    withStorage(fakeStorage(), () => {
      expect(readStoredSplit().pair).toBeNull();
    });
    withStorage(fakeStorage({ [SPLIT_STORAGE_KEY]: "{not json" }), () => {
      expect(readStoredSplit()).toEqual({
        pair: null,
        renderedSecondaryId: null,
        ratio: DEFAULT_RATIO,
        activeSide: "primary",
      });
    });
    withStorage(
      {
        getItem: () => {
          throw new Error("blocked");
        },
      },
      () => {
        expect(readStoredSplit()).toEqual({
          pair: null,
          renderedSecondaryId: null,
          ratio: DEFAULT_RATIO,
          activeSide: "primary",
        });
      },
    );
  });
});

describe("splitStore", () => {
  test("arranges a pair and notifies once per change", () => {
    reset();
    let notified = 0;
    const unsubscribe = splitStore.subscribe(() => {
      notified += 1;
    });

    splitStore.setPair("a", "b");
    expect(splitStore.get().pair).toEqual({ primaryId: "a", secondaryId: "b" });
    expect(notified).toBe(1);

    // Re-asserting the same pair changes nothing, so nothing re-renders.
    splitStore.setPair("a", "b");
    expect(notified).toBe(1);

    unsubscribe();
    splitStore.clear();
    expect(notified).toBe(1);
  });

  test("refuses a workspace beside itself, and refuses half a pair", () => {
    reset();
    splitStore.setPair("a", "a");
    expect(splitStore.get().pair).toBeNull();
    splitStore.setPair("a", null);
    expect(splitStore.get().pair).toBeNull();
    splitStore.setPair("", "b");
    expect(splitStore.get().pair).toBeNull();
  });

  test("the same two workspaces the other way round is a different window", () => {
    reset();
    splitStore.setPair("a", "b");
    splitStore.setPair("b", "a");
    expect(splitStore.get().pair).toEqual({ primaryId: "b", secondaryId: "a" });
  });

  test("rearranging leaves the seam where the user put it", () => {
    reset();
    splitStore.setRatio(0.65);
    splitStore.setPair("a", "b");
    splitStore.setPair("a", "c");
    expect(splitStore.get().pair).toEqual({ primaryId: "a", secondaryId: "c" });
    expect(splitStore.get().ratio).toBe(0.65);
  });

  test("setRatio clamps, so callers may hand it raw pointer arithmetic", () => {
    reset();
    splitStore.setRatio(-2);
    expect(splitStore.get().ratio).toBe(MIN_RATIO);
    splitStore.setRatio(12);
    expect(splitStore.get().ratio).toBe(MAX_RATIO);
    splitStore.setRatio(Number.NaN);
    expect(splitStore.get().ratio).toBe(DEFAULT_RATIO);
  });

  test("the active half is a split-only fact", () => {
    reset();
    splitStore.setActiveSide("secondary");
    expect(splitStore.get().activeSide).toBe("primary");
    splitStore.setPair("a", "b");
    splitStore.setActiveSide("secondary");
    expect(splitStore.get().activeSide).toBe("secondary");
  });
});

describe("splitStore.unsplit", () => {
  test("keeping the half you are already on moves nobody", () => {
    reset();
    splitStore.setPair("a", "b");
    splitStore.setActiveSide("secondary");
    expect(splitStore.unsplit("a", "a")).toBeNull();
    expect(splitStore.get().pair).toBeNull();
    expect(splitStore.get().activeSide).toBe("primary");
  });

  test("keeping the other half hands the caller somewhere to go", () => {
    reset();
    splitStore.setPair("a", "b");
    // Routed at the left half and keeping the right one — the address bar has
    // to follow, or it would be about a workspace no longer on screen.
    expect(splitStore.unsplit("b", "a")).toBe("b");
    expect(splitStore.get().pair).toBeNull();
  });

  test("dissolving a parked pair leaves the page you are on alone", () => {
    reset();
    splitStore.setPair("a", "b");
    // Working in some third workspace: the split is only a row in the rail
    // from here, and putting it away is not a reason to navigate.
    expect(splitStore.unsplit("a", "c")).toBeNull();
    expect(splitStore.get().pair).toBeNull();
  });
});

describe("splitStore.followRoute", () => {
  test("arriving at a half hands it the keyboard", () => {
    reset();
    splitStore.setPair("a", "b");
    splitStore.followRoute("b");
    expect(splitStore.get().activeSide).toBe("secondary");
    splitStore.followRoute("a");
    expect(splitStore.get().activeSide).toBe("primary");
  });

  test("arriving anywhere else starts over at the first half", () => {
    reset();
    splitStore.setPair("a", "b");
    splitStore.setActiveSide("secondary");
    splitStore.followRoute("c");
    expect(splitStore.get().activeSide).toBe("primary");
    // And the arrangement itself is untouched: it is parked, not dismantled.
    expect(splitStore.get().pair).toEqual({ primaryId: "a", secondaryId: "b" });
  });
});

describe("splitStore.reconcile", () => {
  test("a workspace that is no longer listed takes the arrangement with it", () => {
    reset();
    splitStore.setPair("a", "b");
    splitStore.reconcile(new Set(["a"]));
    expect(splitStore.get().pair).toBeNull();

    // Either end of it, not just the second one.
    splitStore.setPair("a", "b");
    splitStore.reconcile(new Set(["b"]));
    expect(splitStore.get().pair).toBeNull();
  });

  test("a pair whose workspaces both still exist is left alone", () => {
    reset();
    splitStore.setPair("a", "b");
    splitStore.reconcile(new Set(["a", "b", "c"]));
    expect(splitStore.get().pair).toEqual({ primaryId: "a", secondaryId: "b" });
  });

  test("a list that has not loaded yet is not evidence of anything", () => {
    reset();
    splitStore.setPair("a", "b");
    splitStore.reconcile(null);
    expect(splitStore.get().pair).toEqual({ primaryId: "a", secondaryId: "b" });
  });
});

describe("splitStore.setRendered", () => {
  test("publishes what is drawn, separately from what is stored", () => {
    reset();
    let notified = 0;
    const unsubscribe = splitStore.subscribe(() => {
      notified += 1;
    });

    // A pair parked behind some other workspace: the arrangement stands, and
    // nothing of it is on screen. Anything reading the split to decide what
    // to paint has to be able to tell those two apart.
    splitStore.setPair("a", "b");
    expect(splitStore.get().pair).toEqual({ primaryId: "a", secondaryId: "b" });
    expect(splitStore.get().renderedSecondaryId).toBeNull();

    splitStore.setRendered("b");
    expect(splitStore.get().renderedSecondaryId).toBe("b");
    expect(notified).toBe(2);

    splitStore.setRendered("b");
    expect(notified).toBe(2);

    unsubscribe();
  });

  test("outlives the pair, which is what a close animation needs", () => {
    reset();
    splitStore.setPair("a", "b");
    splitStore.setRendered("b");
    splitStore.clear();
    // The container still has the outgoing half mounted and collapsing, so
    // the drawn fact stays true until it says otherwise.
    expect(splitStore.get().pair).toBeNull();
    expect(splitStore.get().renderedSecondaryId).toBe("b");
    splitStore.setRendered(null);
    expect(splitStore.get().renderedSecondaryId).toBeNull();
  });
});

describe("splitStore persistence", () => {
  test("writes the arrangement and nothing about the session", () => {
    const storage = fakeStorage();
    withStorage(storage, () => {
      reset();
      splitStore.setPair("a", "b");
      splitStore.setRatio(0.4);
      splitStore.setActiveSide("secondary");
      // A fact about what is mounted right now. Restoring it would assert a
      // half was drawn before anything had been rendered.
      splitStore.setRendered("b");
    });
    const written = storage.getItem?.(SPLIT_STORAGE_KEY) ?? "";
    expect(JSON.parse(written)).toEqual({ primaryId: "a", secondaryId: "b", ratio: 0.4 });
  });

  test("a storage that refuses writes still rearranges the window", () => {
    withStorage(
      {
        getItem: () => null,
        setItem: () => {
          throw new Error("blocked");
        },
      },
      () => {
        reset();
        splitStore.setPair("a", "b");
        expect(splitStore.get().pair).toEqual({ primaryId: "a", secondaryId: "b" });
      },
    );
    reset();
  });
});
