import { moveWindowConfirmation, moveWindowError } from "@/components/workspace-detail/move-window";
import { ApiError } from "@/data/api/client";

// The browser's move-window tests hold the same strings: a change here is a
// change there, in the same commit.
describe("moving a window: what it says", () => {
  test("an agent window's conversation starts fresh on the new host", () => {
    expect(
      moveWindowConfirmation({
        title: "builder",
        hostName: "mac",
        cwd: "/Users/me/code/spawn",
        agent: true,
      }),
    ).toEqual({
      title: "Move builder to mac?",
      description:
        "The window moves to ~/code/spawn on mac, and what runs in it here stops. Its agent starts a new conversation there.",
      confirmLabel: "Move window",
    });
  });

  test("a shell window starts a new shell", () => {
    expect(
      moveWindowConfirmation({
        title: "spawn · Shell",
        hostName: "dream",
        cwd: "/srv",
        agent: false,
      }).description,
    ).toBe(
      "The window moves to /srv on dream, and what runs in it here stops. A new shell starts there.",
    );
  });

  test("names the refusals a person can act on", () => {
    const refused = (status: number, detail: string) =>
      new ApiError(status, `http_${status}`, detail, detail);
    expect(moveWindowError(refused(409, "move_conflict"), "mac")).toBe(
      "This window was moved from another device in the meantime, so it was left where it is now.",
    );
    expect(moveWindowError(refused(409, "target_offline"), "mac")).toBe(
      "mac is offline, so the window stayed where it was.",
    );
    expect(moveWindowError(refused(400, "same_host"), "mac")).toBe(
      "This window already runs on mac.",
    );
    expect(moveWindowError(refused(404, "host not found"), "mac")).toBe("host not found");
    expect(moveWindowError(new Error("Network request failed"), "mac")).toBe(
      "Network request failed",
    );
  });
});
