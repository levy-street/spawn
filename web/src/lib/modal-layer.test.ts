import { describe, expect, test } from "bun:test";

import { announceModalOpen, subscribeToModalOpen } from "./modal-layer";

describe("modal layer", () => {
  test("a popup already up when a modal opens is dismissed", () => {
    let dismissed = 0;
    const stop = subscribeToModalOpen(() => {
      dismissed += 1;
    });
    announceModalOpen();
    expect(dismissed).toBe(1);
    stop();
  });

  test("a popup opened from inside a modal is not dismissed by it", () => {
    // The order is the whole rule: the dialog announced itself before this
    // menu existed, so the menu — its own child — never hears about it.
    announceModalOpen();
    let dismissed = 0;
    const stop = subscribeToModalOpen(() => {
      dismissed += 1;
    });
    expect(dismissed).toBe(0);
    stop();
  });

  test("a dismissed popup unsubscribing mid-announcement still lets its peers hear it", () => {
    // What actually happens on dismissal: closing unmounts the effect, which
    // unsubscribes while the announcement is still being delivered.
    const heard: string[] = [];
    const stopFirst = subscribeToModalOpen(() => {
      heard.push("first");
      stopFirst();
    });
    const stopSecond = subscribeToModalOpen(() => {
      heard.push("second");
      stopSecond();
    });

    announceModalOpen();
    expect(heard).toEqual(["first", "second"]);

    // Both are gone: a second modal reaches neither.
    announceModalOpen();
    expect(heard).toEqual(["first", "second"]);
  });

  test("an unsubscribed popup hears nothing", () => {
    let dismissed = 0;
    subscribeToModalOpen(() => {
      dismissed += 1;
    })();
    announceModalOpen();
    expect(dismissed).toBe(0);
  });
});
