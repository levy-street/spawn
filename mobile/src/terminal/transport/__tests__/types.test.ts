import {
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

  test("warns and degrades an unrecognised transport policy to all", () => {
    const warning = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readTransportPolicy("private-only")).toBe("all");
    expect(warning).toHaveBeenCalledWith(
      "Ignoring unrecognised ice_transport_policy: private-only",
    );
    warning.mockRestore();
  });
});
