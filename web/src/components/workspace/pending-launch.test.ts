import assert from "node:assert/strict";
import { attachedLaunchHost, PENDING_LAUNCH_TTL_MS, pendingLaunch } from "./pending-launch";

declare function describe(name: string, callback: () => void): void;
declare function test(name: string, callback: () => void | Promise<void>): void;

describe("pendingLaunch", () => {
  test("is typed only into the incarnation it was queued for", () => {
    pendingLaunch.set("w1", "dream", "claude --session-id a", 0);
    assert.equal(pendingLaunch.has("w1", "mac", 1), false);
    assert.equal(pendingLaunch.take("w1", "mac", 1), null);
    assert.equal(pendingLaunch.has("w1", "dream", 1), true);
    assert.equal(pendingLaunch.take("w1", "dream", 1), "claude --session-id a");
    // Once.
    assert.equal(pendingLaunch.take("w1", "dream", 2), null);
  });

  test("is dropped once the window is seen running elsewhere, and a move back cannot revive it", () => {
    pendingLaunch.set("w2", "dream", "claude --resume x", 0);
    // Seen where it was queued for: kept.
    pendingLaunch.observe("w2", "dream");
    assert.equal(pendingLaunch.has("w2", "dream", 1), true);
    // The window moved on: that incarnation is gone, and so is its command.
    pendingLaunch.observe("w2", "mac");
    assert.equal(pendingLaunch.has("w2", "mac", 1), false);
    // Moved back, it is another incarnation on the same host, and the resume
    // queued for the old one is never typed into it.
    pendingLaunch.observe("w2", "dream");
    assert.equal(pendingLaunch.take("w2", "dream", 2), null);
  });

  test("a launch queued for the window's new host survives seeing it there", () => {
    pendingLaunch.set("w3", "dream", "claude --resume old", 0);
    pendingLaunch.set("w3", "mac", "claude --session-id new", 0);
    pendingLaunch.observe("w3", "mac");
    assert.equal(pendingLaunch.take("w3", "dream", 1), null);
    assert.equal(pendingLaunch.take("w3", "mac", 1), "claude --session-id new");
  });

  test("lapses after the phone's fifteen minutes rather than being typed late", () => {
    assert.equal(PENDING_LAUNCH_TTL_MS, 15 * 60 * 1_000);
    pendingLaunch.set("w4", "dream", "claude --resume x", 1_000);
    assert.equal(pendingLaunch.has("w4", "dream", 1_000 + PENDING_LAUNCH_TTL_MS - 1), true);
    assert.equal(pendingLaunch.take("w4", "dream", 1_000 + PENDING_LAUNCH_TTL_MS), null);
    // Gone, not merely hidden.
    assert.equal(pendingLaunch.has("w4", "dream", 1_000), false);
  });

  test("a refused launch is forgotten", () => {
    pendingLaunch.set("w5", "dream", "claude", 0);
    pendingLaunch.clear("w5");
    assert.equal(pendingLaunch.has("w5", "dream", 1), false);
  });
});

describe("attachedLaunchHost", () => {
  const session = { host_id: "mac" };

  test("names the host a view is attached to when the window runs there", () => {
    assert.equal(attachedLaunchHost(session, { socketState: "open", hostId: "mac" }), "mac");
  });

  test("is nothing while the transport still belongs to the host the window left", () => {
    assert.equal(attachedLaunchHost(session, { socketState: "open", hostId: "dream" }), null);
  });

  test("is nothing until the transport is open and the window is known", () => {
    assert.equal(attachedLaunchHost(session, { socketState: "connecting", hostId: "mac" }), null);
    assert.equal(attachedLaunchHost(session, null), null);
    assert.equal(attachedLaunchHost(undefined, { socketState: "open", hostId: "mac" }), null);
  });
});
