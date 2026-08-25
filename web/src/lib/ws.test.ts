import { describe, expect, test } from "bun:test";

import {
  backoffDelay,
  buildSessionWsUrl,
  iceServersNeedRefresh,
  rtcBindingFrameMatches,
  SPAWN_WS_SUBPROTOCOL,
  sanitizeIceServers,
  sessionRtcTuple,
  socketCloseAction,
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

describe("connection reliability helpers", () => {
  test("keeps jitter inside the documented bounds and applies the cap", () => {
    expect(backoffDelay(0, { base: 500, cap: 30_000 }, () => 0)).toBe(350);
    expect(backoffDelay(0, { base: 500, cap: 30_000 }, () => 1)).toBeCloseTo(650);
    expect(backoffDelay(20, { base: 500, cap: 30_000 }, () => 0)).toBe(21_000);
    expect(backoffDelay(20, { base: 500, cap: 30_000 }, () => 1)).toBeCloseTo(39_000);
  });

  test("classifies permanent and immediate close codes without regressing 4003", () => {
    expect(socketCloseAction(1008)).toBe("unauthorized");
    expect(socketCloseAction(4002)).toBe("client_bug");
    expect(socketCloseAction(4003)).toBe("client_stale");
    expect(socketCloseAction(4010)).toBe("reconnect_immediately");
    for (const code of [1000, 1001, 1006, 1012, 1013, 4008]) {
      expect(socketCloseAction(code)).toBe("reconnect");
    }
  });

  test("sanitizes ICE schemes, credentials, and entry count", () => {
    const valid = Array.from({ length: 10 }, (_, index) => ({
      urls: index === 0 ? "stun:stun.example" : `turn:relay-${index}.example`,
      ...(index === 0 ? {} : { username: "1234567890:user", credential: "secret" }),
    }));
    const result = sanitizeIceServers([
      { urls: "https://not-ice.example" },
      { urls: "turn:no-creds.example" },
      { urls: ["stun:ok.example", "https://mixed.example"] },
      ...valid,
    ]);
    expect(result).toHaveLength(8);
    expect(result[0]).toEqual({ urls: "stun:stun.example" });
  });

  test("refreshes expiring TURN REST credentials but not STUN-only config", () => {
    const now = 2_000_000_000_000;
    const nowSeconds = Math.floor(now / 1000);
    expect(
      iceServersNeedRefresh(
        [{ urls: "turn:relay.example", username: `${nowSeconds + 3599}:user`, credential: "x" }],
        now,
      ),
    ).toBe(true);
    expect(
      iceServersNeedRefresh(
        [{ urls: "turn:relay.example", username: `${nowSeconds + 3601}:user`, credential: "x" }],
        now,
      ),
    ).toBe(false);
    expect(iceServersNeedRefresh([{ urls: "stun:stun.example" }], now)).toBe(false);
  });
});
