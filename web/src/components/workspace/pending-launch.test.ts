import assert from "node:assert/strict";
import { canTypePendingLaunch } from "./pending-launch";

declare function describe(name: string, callback: () => void): void;
declare function test(name: string, callback: () => void | Promise<void>): void;

describe("canTypePendingLaunch", () => {
  const session = { host_id: "mac" };
  const open = { socketState: "open", hostId: "mac" };
  const owner = { owner: true };

  test("types once the view is open to the window's host and holds its display", () => {
    assert.equal(canTypePendingLaunch(session, { connInfo: open, displayState: owner }), true);
  });

  test("waits while the transport still belongs to the host the window left", () => {
    assert.equal(
      canTypePendingLaunch(session, {
        connInfo: { socketState: "open", hostId: "dream" },
        displayState: owner,
      }),
      false,
    );
  });

  test("waits for the display: another device's view would have its input dropped", () => {
    assert.equal(
      canTypePendingLaunch(session, { connInfo: open, displayState: { owner: false } }),
      false,
    );
    assert.equal(canTypePendingLaunch(session, { connInfo: open, displayState: null }), false);
  });

  test("waits for an open transport and a known window", () => {
    assert.equal(
      canTypePendingLaunch(session, {
        connInfo: { socketState: "connecting", hostId: "mac" },
        displayState: owner,
      }),
      false,
    );
    assert.equal(canTypePendingLaunch(undefined, { connInfo: open, displayState: owner }), false);
  });
});
