import { describe, expect, test } from "bun:test";

import {
  buildSessionWsUrl,
  rtcBindingFrameMatches,
  SPAWN_WS_SUBPROTOCOL,
  sessionRtcTuple,
} from "./ws";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

function boundFrame(rtcSessionId: string, nonce: string, generation: number) {
  return {
    session_id: rtcSessionId,
    binding_nonce: nonce,
    binding_generation: generation,
    scope_type: "session",
    scope_id: SESSION_ID,
    protocol: "spawn.pty",
    protocol_version: 2,
  };
}

describe("mandatory session signaling", () => {
  test("uses only spawn.v3 and never discloses viewport dimensions in the URL", () => {
    expect(SPAWN_WS_SUBPROTOCOL).toBe("spawn.v3");
    const url = new URL(buildSessionWsUrl(SESSION_ID));
    expect(url.searchParams.get("session_id")).toBe(SESSION_ID);
    expect(url.searchParams.has("agent_id")).toBe(false);
    expect(url.searchParams.has("cols")).toBe(false);
    expect(url.searchParams.has("rows")).toBe(false);
  });

  test("binds every browser RTC signal to the exact session PTY tuple", () => {
    expect(sessionRtcTuple(SESSION_ID)).toEqual({
      scope_type: "session",
      scope_id: SESSION_ID,
      protocol: "spawn.pty",
      protocol_version: 2,
    });
  });
});

describe("rtcBindingFrameMatches", () => {
  test("rejects a validated frame after the same session id is rebound", () => {
    const stale = boundFrame("reused-session", "a".repeat(32), 7);
    const first = {
      rtcSessionId: "reused-session",
      bindingNonce: "a".repeat(32),
      bindingGeneration: 7,
      sessionId: SESSION_ID,
    };
    const replacement = {
      rtcSessionId: "reused-session",
      bindingNonce: "b".repeat(32),
      bindingGeneration: 7,
      sessionId: SESSION_ID,
    };

    expect(rtcBindingFrameMatches(first, stale)).toBe(true);
    expect(rtcBindingFrameMatches(replacement, stale)).toBe(false);
    expect(
      rtcBindingFrameMatches(replacement, {
        ...stale,
        binding_nonce: replacement.bindingNonce,
        binding_generation: 8,
      }),
    ).toBe(false);
  });

  test("fails closed on a nonce-less frame", () => {
    const current = {
      rtcSessionId: "current",
      bindingNonce: "c".repeat(32),
      bindingGeneration: 3,
      sessionId: SESSION_ID,
    };
    expect(rtcBindingFrameMatches(current, { session_id: "current" })).toBe(false);
    expect(
      rtcBindingFrameMatches(current, { session_id: "current", binding_nonce: "d".repeat(32) }),
    ).toBe(false);
  });

  test("rejects an otherwise valid frame with a missing or mismatched scope tuple", () => {
    const current = {
      rtcSessionId: "current",
      bindingNonce: "c".repeat(32),
      bindingGeneration: 3,
      sessionId: SESSION_ID,
    };
    const frame = boundFrame("current", "c".repeat(32), 3);
    expect(rtcBindingFrameMatches(current, frame)).toBe(true);
    expect(rtcBindingFrameMatches(current, { ...frame, protocol_version: 1 })).toBe(false);
    expect(rtcBindingFrameMatches(current, { ...frame, scope_id: "other-session" })).toBe(false);
    expect(rtcBindingFrameMatches(current, { ...frame, scope_type: "agent" })).toBe(false);
    const { protocol: _protocol, ...missingProtocol } = frame;
    expect(rtcBindingFrameMatches(current, missingProtocol)).toBe(false);
  });
});
