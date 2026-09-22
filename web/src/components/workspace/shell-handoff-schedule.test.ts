import { describe, expect, test } from "bun:test";
import {
  INTERRUPT_PERIOD,
  interruptScheduled,
  OPENING_INTERRUPTS,
} from "@/components/workspace/shell-handoff-schedule";

describe("interruptScheduled", () => {
  test("opens with a Ctrl-C on each of the first polls", () => {
    for (let attempt = 0; attempt < OPENING_INTERRUPTS; attempt += 1) {
      expect(interruptScheduled(attempt)).toBe(true);
    }
    expect(interruptScheduled(OPENING_INTERRUPTS)).toBe(false);
  });

  test("then re-sends a pair every period, so an eaten pair is not the last word", () => {
    const sent = Array.from({ length: 40 }, (_, attempt) => attempt).filter(interruptScheduled);
    expect(sent).toEqual([0, 1, 2, 3, 8, 9, 16, 17, 24, 25, 32, 33]);
    expect(sent.filter((attempt) => attempt >= OPENING_INTERRUPTS).length).toBe(
      2 * Math.floor((40 - 1) / INTERRUPT_PERIOD),
    );
  });
});
