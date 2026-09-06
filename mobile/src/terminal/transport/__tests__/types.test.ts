import {
  ICE_CREDENTIAL_REFRESH_LEAD_MS,
  iceCredentialRefreshDelayMs,
  iceCredentialWindow,
  iceServersNeedRefresh,
  readTransportPolicy,
  sanitizeIceServers,
} from "@/terminal/transport/types";

describe("RTC configuration input", () => {
  test("keeps only safe ICE schemes and requires non-empty TURN credentials", () => {
    expect(
      sanitizeIceServers([
        { urls: "stun:stun.example", username: "ignored", credential: "ignored" },
        { urls: ["turn:turn.example?transport=udp"], username: "123:user", credential: "pw" },
        { urls: "turns:turn.example", username: "", credential: "pw" },
        { urls: "https://exfiltration.example/ice", username: "x", credential: "y" },
        { urls: ["stun:valid.example", "wss://invalid.example"] },
      ]),
    ).toEqual([
      { urls: "stun:stun.example" },
      { urls: ["turn:turn.example?transport=udp"], username: "123:user", credential: "pw" },
    ]);
  });

  test("refreshes expiring TURN credentials but not STUN-only configuration", () => {
    const now = 2_000_000 * 1_000;
    expect(
      iceServersNeedRefresh(
        [{ urls: "turn:turn.example", username: `${2_003_600}:user`, credential: "pw" }],
        now,
      ),
    ).toBe(true);
    expect(
      iceServersNeedRefresh(
        [{ urls: "turn:turn.example", username: `${2_003_601}:user`, credential: "pw" }],
        now,
      ),
    ).toBe(false);
    expect(iceServersNeedRefresh([{ urls: "stun:stun.example" }], now)).toBe(false);
  });

  test("measures the credential's remaining life on the server's clock", () => {
    // The phone runs two hours ahead of the server. Read on the phone's clock,
    // the username's expiry would look two hours nearer than it is; the
    // frame's own `now`/`expires_at` do not.
    const phoneNow = 2_000_000_000_000;
    const serverNow = Math.floor(phoneNow / 1_000) - 2 * 3_600;
    const expiry = serverNow + 7 * 24 * 3_600;
    const turn = [{ urls: "turn:turn.example", username: `${expiry}:user`, credential: "pw" }];
    expect(iceCredentialWindow({ now: serverNow, expires_at: expiry }, turn, phoneNow)).toEqual({
      issuedAtMs: phoneNow,
      expiresAtMs: phoneNow + 7 * 24 * 3_600 * 1_000,
    });
    // A server without the window leaves the username's expiry, as before.
    expect(iceCredentialWindow({}, turn, phoneNow)).toEqual({
      issuedAtMs: phoneNow,
      expiresAtMs: expiry * 1_000,
    });
    expect(iceCredentialWindow({ now: 10, expires_at: 5 }, turn, phoneNow)).toEqual({
      issuedAtMs: phoneNow,
      expiresAtMs: expiry * 1_000,
    });
    // STUN alone has nothing that expires.
    expect(
      iceCredentialWindow(
        { now: serverNow, expires_at: expiry },
        [{ urls: "stun:stun.example" }],
        phoneNow,
      ),
    ).toBeNull();
  });

  test("refreshes an hour early, at half-life when short, and now when late", () => {
    const hour = 3_600 * 1_000;
    const issuedAtMs = 1_000_000;
    const week = { issuedAtMs, expiresAtMs: issuedAtMs + 7 * 24 * hour };
    expect(iceCredentialRefreshDelayMs(week, issuedAtMs)).toBe(
      7 * 24 * hour - ICE_CREDENTIAL_REFRESH_LEAD_MS,
    );
    expect(
      iceCredentialRefreshDelayMs({ issuedAtMs, expiresAtMs: issuedAtMs + 2 * hour }, issuedAtMs),
    ).toBe(hour);
    expect(
      iceCredentialRefreshDelayMs({ issuedAtMs, expiresAtMs: issuedAtMs + hour }, issuedAtMs),
    ).toBe(hour / 2);
    // Slept through the lead, or past the expiry itself: due now, not negative.
    expect(iceCredentialRefreshDelayMs(week, issuedAtMs + 7 * 24 * hour - 1)).toBe(0);
    expect(iceCredentialRefreshDelayMs(week, issuedAtMs + 9 * 24 * hour)).toBe(0);
  });

  test("warns and degrades an unrecognised transport policy to all", () => {
    const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readTransportPolicy("private-only")).toBe("all");
    expect(warning).toHaveBeenCalledWith(
      "Ignoring unrecognised ice_transport_policy: private-only",
    );
    warning.mockRestore();
  });
});
