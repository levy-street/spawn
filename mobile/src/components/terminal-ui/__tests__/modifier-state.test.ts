import {
  activeKeyModifiers,
  INITIAL_MODIFIER_STATE,
  reduceModifierState,
  withActiveModifiers,
} from "@/components/terminal-ui/modifier-state";

describe("terminal modifier state", () => {
  test("a tap arms one key and the sent key consumes it", () => {
    const armed = reduceModifierState(INITIAL_MODIFIER_STATE, {
      type: "tap",
      modifier: "ctrl",
      now: 100,
    });
    expect(armed.ctrl.mode).toBe("armed");
    expect(activeKeyModifiers(armed)).toEqual({ ctrl: true });

    const consumed = reduceModifierState(armed, { type: "key-sent" });
    expect(consumed.ctrl.mode).toBe("off");
  });

  test("a double tap locks and a third tap clears", () => {
    const armed = reduceModifierState(INITIAL_MODIFIER_STATE, {
      type: "tap",
      modifier: "alt",
      now: 100,
    });
    const locked = reduceModifierState(armed, {
      type: "tap",
      modifier: "alt",
      now: 399,
    });
    expect(locked.alt.mode).toBe("locked");
    expect(reduceModifierState(locked, { type: "key-sent" }).alt.mode).toBe("locked");
    expect(reduceModifierState(locked, { type: "tap", modifier: "alt", now: 500 }).alt.mode).toBe(
      "off",
    );
  });

  test("a slow second tap clears instead of locking", () => {
    const armed = reduceModifierState(INITIAL_MODIFIER_STATE, {
      type: "tap",
      modifier: "ctrl",
      now: 100,
    });
    const cleared = reduceModifierState(armed, {
      type: "tap",
      modifier: "ctrl",
      now: 401,
    });
    expect(cleared.ctrl.mode).toBe("off");
  });

  test("long press locks and blur only clears armed modifiers", () => {
    const ctrlLocked = reduceModifierState(INITIAL_MODIFIER_STATE, {
      type: "long-press",
      modifier: "ctrl",
    });
    const altArmed = reduceModifierState(ctrlLocked, {
      type: "tap",
      modifier: "alt",
      now: 100,
    });
    const blurred = reduceModifierState(altArmed, { type: "blur" });
    expect(blurred.ctrl.mode).toBe("locked");
    expect(blurred.alt.mode).toBe("off");
  });

  test("a session change clears locked and armed modifiers", () => {
    const locked = {
      ctrl: { mode: "locked", lastTapAt: null },
      alt: { mode: "armed", lastTapAt: 100 },
    } as const;
    expect(reduceModifierState(locked, { type: "session-changed" })).toEqual(
      INITIAL_MODIFIER_STATE,
    );
  });

  test("active modifiers merge onto a key specification", () => {
    const active = {
      ctrl: { mode: "armed", lastTapAt: 100 },
      alt: { mode: "locked", lastTapAt: null },
    } as const;
    expect(withActiveModifiers(active, { kind: "text", text: "c" })).toEqual({
      kind: "text",
      text: "c",
      modifiers: { ctrl: true, alt: true },
    });
    expect(
      withActiveModifiers(active, {
        kind: "named",
        key: "ArrowUp",
        modifiers: { shift: true },
      }),
    ).toEqual({
      kind: "named",
      key: "ArrowUp",
      modifiers: { ctrl: true, alt: true, shift: true },
    });
  });
});
