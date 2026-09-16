import { describe, expect, test } from "bun:test";

import {
  backoffDelay,
  buildSessionWsUrl,
  ICE_CREDENTIAL_REFRESH_LEAD_MS,
  iceCredentialRefreshDelayMs,
  iceCredentialWindow,
  iceServersNeedRefresh,
  rtcBindingFrameMatches,
  SPAWN_WS_SUBPROTOCOL,
  sanitizeIceServers,
  sessionRtcTuple,
  socketCloseAction,
  watchSuspendResume,
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
  test("suspend watcher fires only when the clock provably jumped", async () => {
    // The helper no-ops without a window (SSR); this file runs without a DOM.
    (globalThis as { window?: object }).window ??= {};
    let now = 1_000_000;
    let resumed = 0;
    const stop = watchSuspendResume(
      () => {
        resumed += 1;
      },
      5,
      45_000,
      () => now,
    );
    // Ordinary ticks: the clock moves with the timer, no jump.
    await Bun.sleep(20);
    expect(resumed).toBe(0);
    // The machine slept: the next tick sees far more wall clock than the
    // interval could explain.
    now += 120_000;
    await Bun.sleep(20);
    expect(resumed).toBe(1);
    // One suspend fires once, not once per tick after it.
    await Bun.sleep(20);
    expect(resumed).toBe(1);
    stop();
    now += 240_000;
    await Bun.sleep(20);
    expect(resumed).toBe(1);
  });

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

describe("relay credential window", () => {
  const HOUR = 60 * 60 * 1000;
  const turn = (expirySeconds: number) => [
    { urls: "turn:relay.example", username: `${expirySeconds}:user`, credential: "x" },
  ];

  test("measures the remaining lifetime on the server's clock, not the device's", () => {
    // The device runs two hours ahead of the server. The username's expiry
    // would read as two hours nearer than it is; the frame's own window does not.
    const deviceNow = 2_000_000_000_000;
    const serverNow = Math.floor(deviceNow / 1000) - 2 * 3600;
    const window = iceCredentialWindow(
      { now: serverNow, expires_at: serverNow + 7 * 24 * 3600 },
      turn(serverNow + 7 * 24 * 3600),
      deviceNow,
    );
    expect(window).toEqual({
      issuedAtMs: deviceNow,
      expiresAtMs: deviceNow + 7 * 24 * HOUR,
    });
  });

  test("falls back to the username's expiry when the server sends no window", () => {
    const now = 2_000_000_000_000;
    const expiry = Math.floor(now / 1000) + 3600;
    expect(iceCredentialWindow({}, turn(expiry), now)).toEqual({
      issuedAtMs: now,
      expiresAtMs: expiry * 1000,
    });
    // A window that does not make sense is ignored the same way.
    expect(iceCredentialWindow({ now: 10, expires_at: 5 }, turn(expiry), now)).toEqual({
      issuedAtMs: now,
      expiresAtMs: expiry * 1000,
    });
  });

  test("has nothing to schedule without a TURN credential", () => {
    const now = 2_000_000_000_000;
    const serverNow = Math.floor(now / 1000);
    expect(
      iceCredentialWindow(
        { now: serverNow, expires_at: serverNow + 3600 },
        [{ urls: "stun:stun.example" }],
        now,
      ),
    ).toBeNull();
    expect(iceCredentialWindow({}, [], now)).toBeNull();
  });

  test("refreshes an hour early, at half-life for short lifetimes, and now when late", () => {
    const issuedAtMs = 1_000_000;
    const week = { issuedAtMs, expiresAtMs: issuedAtMs + 7 * 24 * HOUR };
    expect(iceCredentialRefreshDelayMs(week, issuedAtMs)).toBe(
      7 * 24 * HOUR - ICE_CREDENTIAL_REFRESH_LEAD_MS,
    );
    expect(iceCredentialRefreshDelayMs(week, issuedAtMs + 3 * 24 * HOUR)).toBe(
      4 * 24 * HOUR - ICE_CREDENTIAL_REFRESH_LEAD_MS,
    );
    // Two hours is the boundary: at or above it the lead is the full hour.
    const twoHours = { issuedAtMs, expiresAtMs: issuedAtMs + 2 * HOUR };
    expect(iceCredentialRefreshDelayMs(twoHours, issuedAtMs)).toBe(HOUR);
    const ninety = { issuedAtMs, expiresAtMs: issuedAtMs + 90 * 60_000 };
    expect(iceCredentialRefreshDelayMs(ninety, issuedAtMs)).toBe(45 * 60_000);
    // A device that slept through the lead, or past the expiry itself, is due now.
    expect(iceCredentialRefreshDelayMs(week, issuedAtMs + 7 * 24 * HOUR - 10)).toBe(0);
    expect(iceCredentialRefreshDelayMs(week, issuedAtMs + 8 * 24 * HOUR)).toBe(0);
  });
});
