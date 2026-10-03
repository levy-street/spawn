import { hostLiveStatus } from "@/data/selectors/host-live";

const dream = { name: "dream", status: "online" };

describe("hostLiveStatus", () => {
  it("lets the server's offline win", () => {
    expect(
      hostLiveStatus(
        { name: "pallete", status: "offline" },
        { state: "reconnecting", problem: null, seenReady: true },
      ),
    ).toMatchObject({ tone: "offline", reconnecting: false });
  });

  it("reads connected until this device has lost a connection it had", () => {
    expect(
      hostLiveStatus(dream, { state: "connecting", problem: null, seenReady: false }).tone,
    ).toBe("active");
    expect(hostLiveStatus(dream, { state: "ready", problem: null, seenReady: true }).tone).toBe(
      "active",
    );
    expect(
      hostLiveStatus(dream, { state: "reconnecting", problem: null, seenReady: true }),
    ).toMatchObject({
      tone: "warning",
      label: "Reconnecting to dream…",
      reconnecting: true,
    });
  });

  it("says why when the connection needs attention", () => {
    expect(
      hostLiveStatus(dream, { state: "failed", problem: "Approve this phone", seenReady: false }),
    ).toMatchObject({
      tone: "warning",
      problem: "Approve this phone",
    });
  });
});
