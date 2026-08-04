import { describe, expect, test } from "bun:test";
import { PredictiveEcho } from "./predictive-echo";

const at = (row: number, col: number) => ({ row, col });

describe("PredictiveEcho", () => {
  test("predicts printable chars and confirms them as the cursor advances", () => {
    const echo = new PredictiveEcho();
    expect(echo.predict("h", at(5, 10), 120, 0)).toBe(true);
    expect(echo.predict("i", at(5, 10), 120, 5)).toBe(true);
    expect(echo.pendingText).toBe("hi");

    // Echo lands one char at a time.
    let outcome = echo.reconcile(at(5, 11), "h", 30);
    expect(outcome).toEqual({ pending: "i", mispredicted: false });
    outcome = echo.reconcile(at(5, 12), "hi", 60);
    expect(outcome).toEqual({ pending: "", mispredicted: false });
  });

  test("confirms a batched echo covering several predictions at once", () => {
    const echo = new PredictiveEcho();
    for (const c of "abc") echo.predict(c, at(2, 4), 120, 0);
    const outcome = echo.reconcile(at(2, 7), "xxabc".slice(-3), 40);
    expect(outcome).toEqual({ pending: "", mispredicted: false });
  });

  test("contradicting echo clears and eventually trips the breaker", () => {
    const echo = new PredictiveEcho();
    echo.predict("a", at(1, 1), 120, 0);
    expect(echo.reconcile(at(1, 2), "z", 10).mispredicted).toBe(true);
    expect(echo.pendingText).toBe("");
    expect(echo.enabled(20)).toBe(true);

    // Second hard miss inside the window disables prediction.
    echo.predict("b", at(1, 2), 120, 30);
    expect(echo.reconcile(at(1, 3), "q", 40).mispredicted).toBe(true);
    expect(echo.enabled(50)).toBe(false);
    expect(echo.predict("c", at(1, 3), 120, 60)).toBe(false);
    // ...and recovers after the cool-off.
    expect(echo.enabled(40 + 31_000)).toBe(true);
  });

  test("row changes and over-advances drop softly without penalty", () => {
    const echo = new PredictiveEcho();
    echo.predict("a", at(3, 5), 120, 0);
    expect(echo.reconcile(at(4, 0), "", 10)).toEqual({ pending: "", mispredicted: false });
    expect(echo.enabled(20)).toBe(true);

    echo.predict("b", at(4, 0), 120, 30);
    // App emitted more than predicted (rewrite): ambiguous, soft drop.
    expect(echo.reconcile(at(4, 9), "completed", 40)).toEqual({
      pending: "",
      mispredicted: false,
    });
    expect(echo.enabled(50)).toBe(true);
  });

  test("non-printable input clears predictions and is never predicted", () => {
    const echo = new PredictiveEcho();
    echo.predict("a", at(1, 1), 120, 0);
    expect(echo.predict("\r", at(1, 2), 120, 5)).toBe(false);
    expect(echo.pendingText).toBe("");
    expect(echo.predict("\x1b[A", at(1, 1), 120, 10)).toBe(false);
    expect(echo.predict("\x7f", at(1, 1), 120, 15)).toBe(false);
  });

  test("never predicts across the wrap boundary", () => {
    const echo = new PredictiveEcho();
    expect(echo.predict("a", at(1, 119), 120, 0)).toBe(false);
    expect(echo.predict("a", at(1, 100), 120, 0)).toBe(true);
    // Growing predictions respect the remaining width.
    let accepted = 0;
    for (let i = 0; i < 30; i += 1) {
      if (echo.predict("x", at(1, 100), 120, i)) accepted += 1;
    }
    expect(accepted).toBeLessThan(20);
  });

  test("quiet echo drops stale predictions after the timeout", () => {
    const echo = new PredictiveEcho();
    echo.predict("a", at(1, 1), 120, 0);
    // Status repaint with no cursor advance, before timeout: keep waiting.
    expect(echo.reconcile(at(1, 1), "", 500).pending).toBe("a");
    // Past the timeout: give up softly.
    expect(echo.reconcile(at(1, 1), "", 2_600).pending).toBe("");
    expect(echo.enabled(2_700)).toBe(true);
  });
});
