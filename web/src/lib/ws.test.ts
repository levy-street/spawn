import { describe, expect, test } from "bun:test";

import { agentRtcTuple, buildAgentWsUrl, rtcBindingFrameMatches, SPAWN_WS_SUBPROTOCOL } from "./ws";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";

function boundFrame(sessionId: string, nonce: string, generation: number) {
  return {
    session_id: sessionId,
    binding_nonce: nonce,
    binding_generation: generation,
    agent_id: AGENT_ID,
    scope_type: "agent",
    scope_id: AGENT_ID,
    protocol: "spawn.pty",
    protocol_version: 2,
  };
}

describe("mandatory agent signaling", () => {
  test("uses only spawn.v2 and never discloses viewport dimensions in the URL", () => {
    expect(SPAWN_WS_SUBPROTOCOL).toBe("spawn.v2");
    const url = new URL(buildAgentWsUrl(AGENT_ID));
    expect(url.searchParams.get("agent_id")).toBe(AGENT_ID);
    expect(url.searchParams.has("cols")).toBe(false);
    expect(url.searchParams.has("rows")).toBe(false);
  });

  test("binds every browser RTC signal to the exact agent PTY tuple", () => {
    expect(agentRtcTuple(AGENT_ID)).toEqual({
      agent_id: AGENT_ID,
      scope_type: "agent",
      scope_id: AGENT_ID,
      protocol: "spawn.pty",
      protocol_version: 2,
    });
  });
});

describe("rtcBindingFrameMatches", () => {
  test("rejects a validated frame after the same session id is rebound", () => {
    const stale = boundFrame("reused-session", "a".repeat(32), 7);
    const first = {
      sessionId: "reused-session",
      bindingNonce: "a".repeat(32),
      bindingGeneration: 7,
      agentId: AGENT_ID,
    };
    const replacement = {
      sessionId: "reused-session",
      bindingNonce: "b".repeat(32),
      bindingGeneration: 7,
      agentId: AGENT_ID,
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

  test("fails closed on a nonce-less v2 frame", () => {
    const current = {
      sessionId: "current",
      bindingNonce: "c".repeat(32),
      bindingGeneration: 3,
      agentId: AGENT_ID,
    };
    expect(rtcBindingFrameMatches(current, { session_id: "current" })).toBe(false);
    expect(
      rtcBindingFrameMatches(current, { session_id: "current", binding_nonce: "d".repeat(32) }),
    ).toBe(false);
  });

  test("rejects an otherwise valid frame with a missing or mismatched agent tuple", () => {
    const current = {
      sessionId: "current",
      bindingNonce: "c".repeat(32),
      bindingGeneration: 3,
      agentId: AGENT_ID,
    };
    const frame = boundFrame("current", "c".repeat(32), 3);
    expect(rtcBindingFrameMatches(current, frame)).toBe(true);
    expect(rtcBindingFrameMatches(current, { ...frame, protocol_version: 1 })).toBe(false);
    expect(rtcBindingFrameMatches(current, { ...frame, scope_id: "other-agent" })).toBe(false);
    const { protocol: _protocol, ...missingProtocol } = frame;
    expect(rtcBindingFrameMatches(current, missingProtocol)).toBe(false);
  });
});
