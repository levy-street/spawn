import { describe, expect, test } from "bun:test";

import {
  alertKindEnabled,
  DEFAULT_NOTIFY_PREFS,
  NOTIFY_STORAGE_KEY,
  normalizeNotifyPrefs,
  readStoredNotifyPrefs,
} from "./notify-prefs";

/**
 * The store's stateful half is a module singleton bound to the first
 * `localStorage` it sees, so the pure entry points are what get exercised
 * here: normalization, the read path, and the blocked-storage fallback that
 * must never throw.
 */

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

describe("normalizeNotifyPrefs", () => {
  test("defaults are toast-only: nothing that leaves the tab is on until asked for", () => {
    expect(DEFAULT_NOTIFY_PREFS.toast).toBe(true);
    expect(DEFAULT_NOTIFY_PREFS.sound).toBe(false);
    expect(DEFAULT_NOTIFY_PREFS.system).toBe(false);
    expect(DEFAULT_NOTIFY_PREFS.haptics).toBe(false);
  });

  test("fills every missing field from the defaults", () => {
    expect(normalizeNotifyPrefs({ sound: true })).toEqual({
      ...DEFAULT_NOTIFY_PREFS,
      sound: true,
    });
  });

  test("ignores values of the wrong type rather than propagating them", () => {
    const prefs = normalizeNotifyPrefs({
      toast: "yes",
      sound: 1,
      system: null,
      mutedSessions: "a-session",
    });
    expect(prefs).toEqual(DEFAULT_NOTIFY_PREFS);
  });

  test("rejects non-object input", () => {
    for (const value of [null, undefined, 7, "prefs", []]) {
      expect(normalizeNotifyPrefs(value)).toEqual(DEFAULT_NOTIFY_PREFS);
    }
  });

  test("dedupes and bounds the mute list", () => {
    const many = Array.from({ length: 250 }, (_, index) => `session-${index}`);
    const prefs = normalizeNotifyPrefs({ mutedSessions: [...many, "session-0", "session-0"] });
    expect(prefs.mutedSessions).toHaveLength(200);
    // Newest kept: an unbounded list on a long-lived browser is a slow leak.
    expect(prefs.mutedSessions.at(-1)).toBe("session-249");
  });

  test("drops non-string entries from the mute list", () => {
    const prefs = normalizeNotifyPrefs({ mutedSessions: ["a", 7, null, "b"] });
    expect(prefs.mutedSessions).toEqual(["a", "b"]);
  });
});

describe("readStoredNotifyPrefs", () => {
  test("a server render has no window and gets the defaults", () => {
    expect(readStoredNotifyPrefs()).toEqual(DEFAULT_NOTIFY_PREFS);
  });

  test("round-trips a stored value", () => {
    withStorage(
      fakeStorage({ [NOTIFY_STORAGE_KEY]: JSON.stringify({ sound: true, haptics: true }) }),
      () => {
        const prefs = readStoredNotifyPrefs();
        expect(prefs.sound).toBe(true);
        expect(prefs.haptics).toBe(true);
        expect(prefs.toast).toBe(true);
      },
    );
  });

  test("empty storage yields the defaults", () => {
    withStorage(fakeStorage(), () => {
      expect(readStoredNotifyPrefs()).toEqual(DEFAULT_NOTIFY_PREFS);
    });
  });

  test("corrupt JSON degrades to defaults instead of throwing", () => {
    withStorage(fakeStorage({ [NOTIFY_STORAGE_KEY]: "{not json" }), () => {
      expect(readStoredNotifyPrefs()).toEqual(DEFAULT_NOTIFY_PREFS);
    });
  });

  test("storage that throws on read degrades to defaults", () => {
    withStorage(
      {
        getItem: () => {
          throw new DOMException("blocked", "SecurityError");
        },
      },
      () => {
        expect(() => readStoredNotifyPrefs()).not.toThrow();
        expect(readStoredNotifyPrefs()).toEqual(DEFAULT_NOTIFY_PREFS);
      },
    );
  });
});

describe("alertKindEnabled", () => {
  test("gates each event class on its own switch", () => {
    const prefs = { ...DEFAULT_NOTIFY_PREFS, onFinished: true, onDied: false };
    expect(alertKindEnabled(prefs, "agent.finished")).toBe(true);
    expect(alertKindEnabled(prefs, "session.died")).toBe(false);
  });

  test("the waiting event has its own switch, on by default", () => {
    // The one that actually fires for a coding agent: they idle at a prompt
    // between turns rather than exiting, so `agent.finished` rarely lands.
    expect(alertKindEnabled(DEFAULT_NOTIFY_PREFS, "agent.awaiting_input")).toBe(true);
    expect(
      alertKindEnabled({ ...DEFAULT_NOTIFY_PREFS, onAwaiting: false }, "agent.awaiting_input"),
    ).toBe(false);
  });

  test("an unknown event class is never delivered", () => {
    expect(alertKindEnabled(DEFAULT_NOTIFY_PREFS, "agent.gave_up")).toBe(false);
  });
});
