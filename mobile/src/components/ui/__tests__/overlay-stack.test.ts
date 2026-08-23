import {
  enterOverlay,
  leaveOverlay,
  markOverlayClosing,
  type OverlayEntry,
  resetOverlayStack,
  resolveOverlayClose,
  restoreOverlay,
} from "@/components/ui/overlay-stack";

function makeEntry(): OverlayEntry & { restored: number; torndown: number } {
  const entry = {
    suspended: false,
    closing: false,
    restored: 0,
    torndown: 0,
    restore: () => {
      entry.restored += 1;
    },
    teardown: () => {
      entry.torndown += 1;
    },
  };
  return entry;
}

describe("returning to the drawer underneath", () => {
  beforeEach(() => resetOverlayStack());

  test("a drawer its owner closed under a drawer that opened waits rather than leaving", () => {
    const menu = makeEntry();
    enterOverlay(menu);
    const picker = makeEntry();
    enterOverlay(picker);

    expect(resolveOverlayClose(menu, "owner")).toBe("suspend");
    expect(menu.suspended).toBe(true);
    expect(menu.torndown).toBe(0);
  });

  test("dismissing the drawer on top puts the one waiting under it back", () => {
    const menu = makeEntry();
    enterOverlay(menu);
    const picker = makeEntry();
    enterOverlay(picker);
    resolveOverlayClose(menu, "owner");

    expect(resolveOverlayClose(picker, "user")).toBe("teardown");
    expect(menu.restored).toBe(1);
    expect(menu.suspended).toBe(false);
    expect(menu.torndown).toBe(0);
  });

  test("finishing the action in the drawer on top takes the whole stack with it", () => {
    const menu = makeEntry();
    enterOverlay(menu);
    const picker = makeEntry();
    enterOverlay(picker);
    resolveOverlayClose(menu, "owner");

    expect(resolveOverlayClose(picker, "owner")).toBe("teardown");
    expect(menu.torndown).toBe(1);
    expect(menu.restored).toBe(0);
  });

  test("carries all the way down a chain of drawers when the innermost acts", () => {
    const menu = makeEntry();
    const middle = makeEntry();
    const inner = makeEntry();
    enterOverlay(menu);
    enterOverlay(middle);
    resolveOverlayClose(menu, "owner");
    enterOverlay(inner);
    resolveOverlayClose(middle, "owner");

    resolveOverlayClose(inner, "owner");
    expect(middle.torndown).toBe(1);
    expect(menu.torndown).toBe(1);
  });

  test("but a dismissal only brings back the one drawer it was opened from", () => {
    const menu = makeEntry();
    const middle = makeEntry();
    const inner = makeEntry();
    enterOverlay(menu);
    enterOverlay(middle);
    resolveOverlayClose(menu, "owner");
    enterOverlay(inner);
    resolveOverlayClose(middle, "owner");

    resolveOverlayClose(inner, "user");
    expect(middle.restored).toBe(1);
    expect(menu.restored).toBe(0);
    expect(menu.suspended).toBe(true);
  });

  test("a drawer the person dismissed themselves never waits, whatever is above it", () => {
    const menu = makeEntry();
    enterOverlay(menu);
    const picker = makeEntry();
    enterOverlay(picker);

    expect(resolveOverlayClose(menu, "user")).toBe("teardown");
    expect(menu.suspended).toBe(false);
  });

  test("a drawer already playing its exit is not something to wait under", () => {
    // Navigation clearing the screen closes every drawer at once; without this
    // the bottom one would suspend under the ones on their way out and stay.
    const menu = makeEntry();
    const picker = makeEntry();
    enterOverlay(menu);
    enterOverlay(picker);
    markOverlayClosing(picker);

    expect(resolveOverlayClose(menu, "owner")).toBe("teardown");
  });

  test("an overlay whose owner unmounted it outright is simply gone", () => {
    const menu = makeEntry();
    const picker = makeEntry();
    enterOverlay(menu);
    enterOverlay(picker);
    leaveOverlay(picker);

    expect(resolveOverlayClose(menu, "owner")).toBe("teardown");
    expect(menu.suspended).toBe(false);
  });

  test("restoring something that is not waiting does nothing", () => {
    const menu = makeEntry();
    enterOverlay(menu);

    restoreOverlay(menu);
    expect(menu.restored).toBe(0);
  });
});
