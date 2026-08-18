import { describe, expect, test } from "bun:test";

import { highlightStore } from "./highlight-store";

describe("highlightStore", () => {
  test("set/get/clear round-trips and notifies subscribers once per change", () => {
    highlightStore.clear();
    let notified = 0;
    const unsubscribe = highlightStore.subscribe(() => {
      notified += 1;
    });

    highlightStore.set("session-a");
    expect(highlightStore.get()).toBe("session-a");
    expect(notified).toBe(1);

    // Setting the same value must not re-notify (render-loop hygiene).
    highlightStore.set("session-a");
    expect(notified).toBe(1);

    highlightStore.set("session-b");
    expect(highlightStore.get()).toBe("session-b");
    expect(notified).toBe(2);

    highlightStore.clear();
    expect(highlightStore.get()).toBeNull();
    expect(notified).toBe(3);

    unsubscribe();
    highlightStore.set("session-c");
    expect(notified).toBe(3);
    highlightStore.clear();
  });
});
