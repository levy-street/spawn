import assert from "node:assert/strict";
import { ApiError } from "@/lib/api";
import { moveWindowConfirmation, moveWindowError } from "./move-window";

declare function describe(name: string, callback: () => void): void;
declare function test(name: string, callback: () => void | Promise<void>): void;

// The phone's move-window tests hold the same strings: a change here is a
// change there, in the same commit.
describe("moveWindowConfirmation", () => {
  test("says an agent window's conversation starts fresh on the new host", () => {
    assert.deepEqual(
      moveWindowConfirmation({
        title: "builder",
        hostName: "mac",
        cwd: "/Users/me/code/spawn",
        agent: true,
      }),
      {
        title: "Move builder to mac?",
        body: "The window moves to ~/code/spawn on mac, and what runs in it here stops. Its agent starts a new conversation there.",
        confirmLabel: "Move window",
      },
    );
  });

  test("says a shell window starts a new shell", () => {
    assert.equal(
      moveWindowConfirmation({
        title: "spawn · Shell",
        hostName: "dream",
        cwd: "/srv",
        agent: false,
      }).body,
      "The window moves to /srv on dream, and what runs in it here stops. A new shell starts there.",
    );
  });
});

describe("moveWindowError", () => {
  const refused = (status: number, detail: string) =>
    new ApiError(status, `http_${status}`, detail, detail);

  test("names the cases a person can act on", () => {
    assert.equal(
      moveWindowError(refused(409, "move_conflict"), "mac"),
      "This window was moved from another device in the meantime, so it was left where it is now.",
    );
    assert.equal(
      moveWindowError(refused(409, "target_offline"), "mac"),
      "mac is offline, so the window stayed where it was.",
    );
    assert.equal(
      moveWindowError(refused(400, "same_host"), "mac"),
      "This window already runs on mac.",
    );
  });

  test("passes anything else through as it was said", () => {
    assert.equal(moveWindowError(refused(404, "host not found"), "mac"), "host not found");
    assert.equal(moveWindowError(new Error("Failed to fetch"), "mac"), "Failed to fetch");
  });
});
