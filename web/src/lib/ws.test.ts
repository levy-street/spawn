import { describe, expect, test } from "bun:test";

import { rtcBindingFrameMatches } from "./ws";

describe("rtcBindingFrameMatches", () => {
  test("rejects a validated frame after the same session id is rebound", () => {
    const stale = {
      session_id: "reused-session",
      binding_nonce: "a".repeat(32),
      binding_generation: 7,
    };
    const first = {
      sessionId: "reused-session",
      bindingNonce: "a".repeat(32),
      bindingGeneration: 7,
    };
    const replacement = {
      sessionId: "reused-session",
      bindingNonce: "b".repeat(32),
      bindingGeneration: 7,
    };

    expect(rtcBindingFrameMatches(first, stale, true)).toBe(true);
    expect(rtcBindingFrameMatches(replacement, stale, true)).toBe(false);
    expect(
      rtcBindingFrameMatches(
        replacement,
        { ...stale, binding_nonce: replacement.bindingNonce, binding_generation: 8 },
        true,
      ),
    ).toBe(false);
  });

  test("fails closed on a nonce-less v2 frame", () => {
    const current = {
      sessionId: "current",
      bindingNonce: "c".repeat(32),
      bindingGeneration: 3,
    };
    expect(rtcBindingFrameMatches(current, { session_id: "current" }, true)).toBe(false);
    expect(rtcBindingFrameMatches(current, { session_id: "current" }, false)).toBe(true);
    expect(
      rtcBindingFrameMatches(
        current,
        { session_id: "current", binding_nonce: "d".repeat(32) },
        false,
      ),
    ).toBe(false);
  });
});
