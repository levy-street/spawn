import { describe, expect, test } from "bun:test";

import {
  clampRatio,
  DEFAULT_RATIO,
  MAX_RATIO,
  MIN_RATIO,
  normalizeSplit,
  readStoredSplit,
  SPLIT_STORAGE_KEY,
  splitStore,
} from "./split-store";

/**
 * The stateful half is a module singleton, so every test here starts from the
 * unsplit default rather than from whatever the last one left behind. Bun runs
 * a file's tests in order, which is what makes that a reset and not a hope.
 */
function reset(): void {
  splitStore.close();
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

describe("normalizeSplit", () => {
  test("survives anything storage could hand back", () => {
    for (const garbage of [null, undefined, 7, "split", [], true, { ratio: "half" }]) {
      expect(normalizeSplit(garbage)).toEqual({
        secondaryId: null,
        renderedSecondaryId: null,
        ratio: DEFAULT_RATIO,
        activeSide: "primary",
      });
    }
  });

  test("keeps a usable pair and clamps the ratio it came with", () => {
    expect(normalizeSplit({ secondaryId: "b", ratio: 0.9 })).toEqual({
      secondaryId: "b",
      renderedSecondaryId: null,
      ratio: MAX_RATIO,
      activeSide: "primary",
    });
  });

  test("rejects an empty or non-string second workspace", () => {
    expect(normalizeSplit({ secondaryId: "" }).secondaryId).toBeNull();
    expect(normalizeSplit({ secondaryId: 12 }).secondaryId).toBeNull();
  });

  test("never restores which half was last typed in", () => {
    // A reload starts at the routed workspace by definition, so a stored
    // "secondary" would hand the keyboard to a half nobody had touched yet.
    expect(normalizeSplit({ secondaryId: "b", activeSide: "secondary" }).activeSide).toBe(
      "primary",
    );
  });
});

describe("readStoredSplit", () => {
  test("restores a written arrangement", () => {
    withStorage(fakeStorage({ [SPLIT_STORAGE_KEY]: '{"secondaryId":"b","ratio":0.3}' }), () => {
      expect(readStoredSplit()).toEqual({
        secondaryId: "b",
        renderedSecondaryId: null,
        ratio: 0.3,
        activeSide: "primary",
      });
    });
  });

  test("a single workspace is the answer when storage is empty, corrupt, or refusing", () => {
    withStorage(fakeStorage(), () => {
      expect(readStoredSplit().secondaryId).toBeNull();
    });
    withStorage(fakeStorage({ [SPLIT_STORAGE_KEY]: "{not json" }), () => {
      expect(readStoredSplit()).toEqual({
        secondaryId: null,
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
          secondaryId: null,
          renderedSecondaryId: null,
          ratio: DEFAULT_RATIO,
          activeSide: "primary",
        });
      },
    );
  });
});

describe("splitStore", () => {
  test("opens beside the routed workspace and notifies once per change", () => {
    reset();
    let notified = 0;
    const unsubscribe = splitStore.subscribe(() => {
      notified += 1;
    });

    splitStore.open("b", "a");
    expect(splitStore.get().secondaryId).toBe("b");
    expect(notified).toBe(1);

    // Re-opening the same pair changes nothing, so nothing re-renders.
    splitStore.open("b", "a");
    expect(notified).toBe(1);

    unsubscribe();
    splitStore.close();
    expect(notified).toBe(1);
  });

  test("refuses a workspace beside itself, and refuses no workspace at all", () => {
    reset();
    splitStore.open("a", "a");
    expect(splitStore.get().secondaryId).toBeNull();
    splitStore.open("", "a");
    expect(splitStore.get().secondaryId).toBeNull();
  });

  test("replacing the second workspace leaves the seam where the user put it", () => {
    reset();
    splitStore.setRatio(0.65);
    splitStore.open("b", "a");
    splitStore.open("c", "a");
    expect(splitStore.get().secondaryId).toBe("c");
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

  test("close keeps the routed workspace and hands the keyboard back to it", () => {
    reset();
    splitStore.open("b", "a");
    splitStore.setActiveSide("secondary");
    splitStore.close();
    expect(splitStore.get().secondaryId).toBeNull();
    expect(splitStore.get().activeSide).toBe("primary");
  });

  test("promoteSecondary returns the workspace to navigate to and clears the pair", () => {
    reset();
    splitStore.open("b", "a");
    splitStore.setActiveSide("secondary");
    expect(splitStore.promoteSecondary()).toBe("b");
    expect(splitStore.get().secondaryId).toBeNull();
    expect(splitStore.get().activeSide).toBe("primary");
    // Nothing left to promote; the caller must not be sent anywhere.
    expect(splitStore.promoteSecondary()).toBeNull();
  });

  test("the active half is a split-only fact", () => {
    reset();
    splitStore.setActiveSide("secondary");
    expect(splitStore.get().activeSide).toBe("primary");
    splitStore.open("b", "a");
    splitStore.setActiveSide("secondary");
    expect(splitStore.get().activeSide).toBe("secondary");
  });
});

describe("splitStore.reconcile", () => {
  test("navigating to the workspace already beside this one makes it the window", () => {
    reset();
    splitStore.open("b", "a");
    splitStore.setActiveSide("secondary");
    splitStore.reconcile("b", new Set(["a", "b"]));
    expect(splitStore.get().secondaryId).toBeNull();
    expect(splitStore.get().activeSide).toBe("primary");
  });

  test("a workspace that is no longer listed drops out of the arrangement", () => {
    reset();
    splitStore.open("b", "a");
    splitStore.reconcile("a", new Set(["a"]));
    expect(splitStore.get().secondaryId).toBeNull();
  });

  test("a still-listed workspace is left alone", () => {
    reset();
    splitStore.open("b", "a");
    splitStore.reconcile("a", new Set(["a", "b"]));
    expect(splitStore.get().secondaryId).toBe("b");
  });

  test("a list that has not loaded yet is not evidence of anything", () => {
    reset();
    splitStore.open("b", "a");
    splitStore.reconcile("a", null);
    expect(splitStore.get().secondaryId).toBe("b");
    // Null still cannot save a pair the route itself has dissolved.
    splitStore.reconcile("b", null);
    expect(splitStore.get().secondaryId).toBeNull();
  });
});

describe("splitStore.setRendered", () => {
  test("publishes what is drawn, separately from what is stored", () => {
    reset();
    let notified = 0;
    const unsubscribe = splitStore.subscribe(() => {
      notified += 1;
    });

    // The narrow window: the pair is kept so widening restores it, while
    // nothing is drawn beside the primary. Anything reading the arrangement
    // to decide what to paint has to be able to tell these two apart.
    splitStore.open("b", "a");
    expect(splitStore.get().secondaryId).toBe("b");
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
    splitStore.open("b", "a");
    splitStore.setRendered("b");
    splitStore.close();
    // The container still has the outgoing half mounted and collapsing, so
    // the drawn fact stays true until it says otherwise.
    expect(splitStore.get().secondaryId).toBeNull();
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
      splitStore.open("b", "a");
      splitStore.setRatio(0.4);
      splitStore.setActiveSide("secondary");
      // A measurement of this device's window right now. Restoring it would
      // assert a half was drawn before anything had been measured.
      splitStore.setRendered("b");
    });
    const written = storage.getItem?.(SPLIT_STORAGE_KEY) ?? "";
    expect(JSON.parse(written)).toEqual({ secondaryId: "b", ratio: 0.4 });
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
        splitStore.open("b", "a");
        expect(splitStore.get().secondaryId).toBe("b");
      },
    );
    reset();
  });
});
