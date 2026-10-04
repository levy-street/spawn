import { describe, expect, test } from "bun:test";
import { formatDuration } from "./copy";
import { estimateSeconds } from "./estimate";

describe("estimateSeconds", () => {
  test("relayed at 55 ms runs about as S4 measured, 0.9 MB/s", () => {
    const seconds = estimateSeconds(90_000_000, [{ kind: "relay", rttMs: 55 }]);
    expect(seconds).toBeGreaterThan(95);
    expect(seconds).toBeLessThan(110);
  });

  test("the slower leg sets the pace", () => {
    const direct = estimateSeconds(50_000_000, [{ kind: "direct", rttMs: 2 }]);
    const mixed = estimateSeconds(50_000_000, [
      { kind: "direct", rttMs: 2 },
      { kind: "relay", rttMs: 80 },
    ]);
    expect(direct).toBeLessThan(10);
    expect(mixed).toBeGreaterThan(direct * 5);
  });

  test("an unmeasured path is taken at 60 ms, paced at 64 KiB a round trip", () => {
    // 64 KiB / 60 ms ≈ 1.09 MB/s, plus the three fixed seconds: the phone's model.
    const seconds = estimateSeconds(9_000_000, [{ kind: null, rttMs: null }]);
    expect(seconds).toBeGreaterThan(11);
    expect(seconds).toBeLessThan(11.5);
  });

  test("the relay caps a leg at what S4 measured, however short its round trip", () => {
    const seconds = estimateSeconds(9_000_000, [{ kind: "relay", rttMs: 5 }]);
    expect(seconds).toBeCloseTo(3 + 10, 5);
  });
});

describe("formatDuration", () => {
  test.each([
    [12, "10 seconds"],
    [31, "30 seconds"],
    [70, "a minute"],
    [240, "4 minutes"],
    [3500, "an hour"],
    [9000, "3 hours"],
  ])("%d s reads as %s", (seconds, words) => {
    expect(formatDuration(seconds)).toBe(words);
  });
});
